import type { AppDatabase } from "../src/db";
import type { LinkedUser, YoutubeCookieJar } from "../src/types";
import { YoutubeService } from "../src/youtube";

type ScriptArgs = {
	cookieHeader: string;
	maxResults: number;
	minWatchRatio: number;
	repeat: number;
	intervalMs: number;
	printCookieHeader: boolean;
};

function parseArgs(argv: string[]): ScriptArgs {
	const args = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 1) {
		const current = argv[index];
		if (!current || !current.startsWith("--")) {
			continue;
		}

		const key = current.slice(2);
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) {
			continue;
		}
		args.set(key, value);
		index += 1;
	}

	const cookieHeader =
		args.get("cookie") ?? process.env.YOUTUBE_COOKIE_HEADER ?? "";
	if (!cookieHeader.trim()) {
		console.error(
			[
				"Missing cookie header.",
				"Usage:",
				"  bun scripts/test-history-fetch.ts --cookie 'SID=...; HSID=...; SAPISID=...'",
				"  optional: --max 8 --min-watch-ratio 0.75 --repeat 3 --interval-ms 1500 --print-cookie-header",
				"or set YOUTUBE_COOKIE_HEADER in your shell.",
			].join("\n"),
		);
		process.exit(1);
	}

	const maxResults = Number.parseInt(args.get("max") ?? "8", 10);
	const minWatchRatio = Number.parseFloat(
		args.get("min-watch-ratio") ?? "0.75",
	);
	const repeat = Number.parseInt(args.get("repeat") ?? "1", 10);
	const intervalMs = Number.parseInt(args.get("interval-ms") ?? "1000", 10);
	const printCookieHeader = argv.includes("--print-cookie-header");

	if (!Number.isFinite(maxResults) || maxResults <= 0) {
		throw new Error("--max must be a positive integer");
	}

	if (
		!Number.isFinite(minWatchRatio) ||
		minWatchRatio < 0 ||
		minWatchRatio > 1
	) {
		throw new Error("--min-watch-ratio must be between 0 and 1");
	}

	if (!Number.isFinite(repeat) || repeat <= 0) {
		throw new Error("--repeat must be a positive integer");
	}

	if (!Number.isFinite(intervalMs) || intervalMs < 0) {
		throw new Error("--interval-ms must be >= 0");
	}

	return {
		cookieHeader,
		maxResults,
		minWatchRatio,
		repeat,
		intervalMs,
		printCookieHeader,
	};
}

function buildCookieHeaderFromJar(cookieJar: YoutubeCookieJar): string {
	const entries: string[] = [];
	for (const [cookieName, cookie] of Object.entries(cookieJar)) {
		if (!cookieName || !cookie.value) {
			continue;
		}
		entries.push(`${cookieName}=${cookie.value}`);
	}
	return entries.join("; ");
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

function parseCookieJarFromHeader(cookieHeader: string): YoutubeCookieJar {
	const parts = cookieHeader
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);

	const jar: YoutubeCookieJar = {};
	for (const part of parts) {
		const separatorIndex = part.indexOf("=");
		if (separatorIndex <= 0) {
			continue;
		}

		const name = part.slice(0, separatorIndex).trim();
		const value = part.slice(separatorIndex + 1);
		if (!name) {
			continue;
		}

		jar[name] = {
			value,
			expiresAt: null,
			domain: null,
			path: null,
			secure: false,
			httpOnly: false,
			sameSite: null,
		};
	}

	if (Object.keys(jar).length === 0) {
		throw new Error("cookie header did not contain key=value pairs");
	}

	return jar;
}

const input = parseArgs(process.argv.slice(2));
const initialCookieJar = parseCookieJarFromHeader(input.cookieHeader);

let latestCookieJar = initialCookieJar;

const dbStub = {
	saveYoutubeCookieJar(_telegramUserId: number, cookieJar: YoutubeCookieJar) {
		latestCookieJar = cookieJar;
	},
} as unknown as AppDatabase;

const service = new YoutubeService(dbStub);

const linkedUser: LinkedUser = {
	telegramUserId: 0,
	chatId: 0,
	youtubeCookieJar: initialCookieJar,
	lastPolledPublishedAt: null,
};

const runs: Array<{
	iteration: number;
	elapsedMs: number;
	videosFound: number;
	sample: Awaited<ReturnType<YoutubeService["listRecentWatchedVideos"]>>;
}> = [];

for (let iteration = 1; iteration <= input.repeat; iteration += 1) {
	linkedUser.youtubeCookieJar = latestCookieJar;
	const startedAt = Date.now();
	const videos = await service.listRecentWatchedVideos(
		linkedUser,
		input.maxResults,
		input.minWatchRatio,
	);
	const elapsedMs = Date.now() - startedAt;

	runs.push({
		iteration,
		elapsedMs,
		videosFound: videos.length,
		sample: videos.slice(0, 5),
	});

	if (iteration < input.repeat && input.intervalMs > 0) {
		await sleep(input.intervalMs);
	}
}

const initialCookieCount = Object.keys(initialCookieJar).length;
const latestCookieCount = Object.keys(latestCookieJar).length;

console.log(
	JSON.stringify(
		{
			ok: true,
			params: {
				maxResults: input.maxResults,
				minWatchRatio: input.minWatchRatio,
				repeat: input.repeat,
				intervalMs: input.intervalMs,
			},
			cookies: {
				initialCount: initialCookieCount,
				latestCount: latestCookieCount,
				persistedUpdate:
					JSON.stringify(latestCookieJar) !== JSON.stringify(initialCookieJar),
				refreshedHeader: input.printCookieHeader
					? buildCookieHeaderFromJar(latestCookieJar)
					: undefined,
			},
			runs,
		},
		null,
		2,
	),
);
