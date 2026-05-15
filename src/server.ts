import { mkdir, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { verifyAppleIdentityToken } from "./apple-auth";
import { parseYoutubeCookieJarFromHeader } from "./cookies";
import type { AppDatabase } from "./db";
import type { YoutubeCookieJar } from "./types";
import type { YoutubeHistorySourceDebug, YoutubeService } from "./youtube";

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 128 * 1024;
const DEBUG_HTML_DIR = "logs/youtube-history-source";

type ApiServerInput = {
	db: AppDatabase;
	youtubeService: YoutubeService;
};

export function createApiServer(input: ApiServerInput) {
	return createServer(async (req, res) => {
		const startedAt = Date.now();
		const method = req.method ?? "UNKNOWN";
		const path = req.url ?? "/";

		res.on("finish", () => {
			console.log(
				`[api] ${method} ${path} status=${res.statusCode} elapsed_ms=${Date.now() - startedAt}`,
			);
		});

		try {
			await handleRequest(input, req, res);
		} catch (error) {
			const message = error instanceof Error ? error.message : "server error";
			console.error(`[api] ${method} ${path} error=${message}`);
			writeJson(res, 500, { error: message });
		}
	});
}

async function handleRequest(
	input: ApiServerInput,
	req: IncomingMessage,
	res: ServerResponse,
) {
	const url = new URL(req.url ?? "/", "http://localhost");

	if (
		req.method === "GET" &&
		(url.pathname === "/" || url.pathname === "/health")
	) {
		writeJson(res, 200, { ok: true });
		return;
	}

	if (req.method === "POST" && url.pathname === "/auth/apple") {
		const body = await readJsonBody<{ identityToken?: string }>(req);
		if (!body.identityToken) {
			writeJson(res, 400, { error: "identityToken is required" });
			return;
		}

		const identity = await verifyAppleIdentityToken(body.identityToken);
		const user = input.db.upsertAppleUser(identity);
		const sessionToken = crypto.randomUUID() + crypto.randomUUID();
		const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
		input.db.createAppSession({
			appUserId: user.id,
			token: sessionToken,
			expiresAt,
		});

		writeJson(res, 200, {
			sessionToken,
			expiresAt: expiresAt.toISOString(),
			user: {
				id: user.id,
				email: user.email,
				youtubeLinked: user.youtubeLinked,
			},
		});
		return;
	}

	const authedUser = input.db.getAppUserBySessionToken(getBearerToken(req));
	if (!authedUser) {
		writeJson(res, 401, { error: "unauthorized" });
		return;
	}

	if (req.method === "GET" && url.pathname === "/me") {
		writeJson(res, 200, {
			user: {
				id: authedUser.id,
				email: authedUser.email,
				youtubeLinked: authedUser.youtubeLinked,
			},
		});
		return;
	}

	if (req.method === "PUT" && url.pathname === "/youtube/cookies") {
		const body = await readJsonBody<{ cookieHeader?: string }>(req);
		if (!body.cookieHeader) {
			writeJson(res, 400, { error: "cookieHeader is required" });
			return;
		}

		const cookieJar = parseYoutubeCookieJarFromHeader(body.cookieHeader);
		let validatedCookieJar: YoutubeCookieJar;
		try {
			validatedCookieJar = await input.youtubeService.validateCookieJar({
				telegramUserId: -authedUser.id,
				cookieJar,
			});
		} catch (error) {
			const debug = await input.youtubeService.fetchHistorySourceDebug({
				telegramUserId: -authedUser.id,
				cookieJar,
			});
			const debugPath = await saveHistorySourceDebug({
				appUserId: authedUser.id,
				debug,
			});
			const message = error instanceof Error ? error.message : "server error";
			throw new Error(
				`${message} Saved YouTube history source to ${debugPath}.`,
			);
		}
		input.db.saveAppYoutubeCookieJar({
			appUserId: authedUser.id,
			cookieJar: validatedCookieJar,
		});

		writeJson(res, 200, { youtubeLinked: true });
		return;
	}

	if (
		req.method === "PUT" &&
		url.pathname === "/debug/youtube/history-source"
	) {
		const body = await readJsonBody<{ cookieHeader?: string }>(req);
		if (!body.cookieHeader) {
			writeJson(res, 400, { error: "cookieHeader is required" });
			return;
		}

		const debug = await input.youtubeService.fetchHistorySourceDebug({
			telegramUserId: -authedUser.id,
			cookieJar: parseYoutubeCookieJarFromHeader(body.cookieHeader),
		});
		const debugPath = await saveHistorySourceDebug({
			appUserId: authedUser.id,
			debug,
		});

		writeJson(res, 200, { ...debug, debugPath });
		return;
	}

	writeJson(res, 404, { error: "not found" });
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;

	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.byteLength;
		if (totalBytes > MAX_BODY_BYTES) {
			throw new Error("request body too large");
		}
		chunks.push(buffer);
	}

	const rawBody = Buffer.concat(chunks).toString("utf8");
	return rawBody ? (JSON.parse(rawBody) as T) : ({} as T);
}

function getBearerToken(req: IncomingMessage): string | null {
	const authorization = req.headers.authorization;
	if (!authorization?.startsWith("Bearer ")) {
		return null;
	}
	return authorization.slice("Bearer ".length).trim();
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

async function saveHistorySourceDebug(input: {
	appUserId: number;
	debug: YoutubeHistorySourceDebug;
}): Promise<string> {
	await mkdir(DEBUG_HTML_DIR, { recursive: true });
	const timestamp = new Date().toISOString().replaceAll(":", "-");
	const baseName = `app-user-${input.appUserId}-${timestamp}`;
	const firstPath = join(DEBUG_HTML_DIR, `${baseName}-first.html`);
	const finalPath = join(DEBUG_HTML_DIR, `${baseName}-final.html`);
	const browsePath = join(DEBUG_HTML_DIR, `${baseName}-browse.json`);
	const metadataPath = join(DEBUG_HTML_DIR, `${baseName}.json`);

	await Promise.all([
		writeFile(firstPath, input.debug.first.html),
		writeFile(finalPath, input.debug.final.html),
		writeFile(browsePath, JSON.stringify(input.debug.browse.json, null, 2)),
		writeFile(
			metadataPath,
			JSON.stringify(
				{
					...input.debug,
					first: { ...input.debug.first, html: undefined },
					final: { ...input.debug.final, html: undefined },
					browse: { ...input.debug.browse, json: undefined },
					files: { first: firstPath, final: finalPath, browse: browsePath },
				},
				null,
				2,
			),
		),
	]);

	return finalPath;
}
