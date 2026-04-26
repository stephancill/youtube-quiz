import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

type ParsedCliArgs = {
	options: Record<string, string>;
	flags: Set<string>;
};

type CapturedRequest = {
	url: string;
	requestHeaders?: Record<string, string>;
	extraRequestHeaders?: Record<string, string>;
	hasAuthorization?: boolean;
	hasSapisidHashAuth?: boolean;
	responseStatus?: number | null;
};

type CapturedRow = {
	timestamp?: string;
	network?: {
		requests?: CapturedRequest[];
	};
	state?: {
		ytConfig?: {
			innertubeApiKey?: string | null;
			innertubeClientVersion?: string | null;
			sessionIndex?: string | null;
			visitorData?: string | null;
		};
	};
};

type ReplayTemplate = {
	innertubeApiKey: string;
	innertubeClientVersion: string;
	sessionIndex: string;
	visitorData: string | null;
	xYoutubeClientName: string;
	xYoutubeClientVersion: string;
	xGoogAuthUser: string;
	xGoogPageId: string | null;
	userAgent: string;
	acceptLanguage: string;
	cookieHeader: string;
};

type CookieJar = Record<string, string>;

const CRITICAL_AUTH_COOKIES = new Set([
	"SID",
	"HSID",
	"SSID",
	"APISID",
	"SAPISID",
	"LOGIN_INFO",
	"__Secure-1PSID",
	"__Secure-3PSID",
	"__Secure-1PAPISID",
	"__Secure-3PAPISID",
]);

const cliSchema = z.object({
	sourceLog: z.string().min(1).default("logs/history-poll-15m.ndjson"),
	out: z.string().min(1).default("logs/standalone-replay.ndjson"),
	stateOut: z.string().min(1).default("logs/standalone-replay-state.json"),
	repeat: z.coerce.number().int().min(1).default(8),
	intervalMs: z.coerce.number().int().min(0).default(15_000),
	warmupGuideRequests: z.coerce.number().int().min(1).max(5).default(2),
	minVideosHint: z.coerce.number().int().min(0).default(1),
	cookieHeader: z.string().optional(),
	rebootstrapOnAuthFailure: z.coerce.boolean().default(true),
	maxConsecutiveAuthFailures: z.coerce.number().int().min(1).default(2),
});

const ORIGIN = "https://www.youtube.com";
const HISTORY_URL = `${ORIGIN}/feed/history`;

function parseCliArgs(argv: string[]): ParsedCliArgs {
	const options: Record<string, string> = {};
	const flags = new Set<string>();

	for (let index = 0; index < argv.length; index += 1) {
		const current = argv[index];
		if (!current || !current.startsWith("--")) {
			continue;
		}

		const key = current.slice(2);
		const value = argv[index + 1];
		if (!value || value.startsWith("--")) {
			flags.add(key);
			continue;
		}

		options[key] = value;
		index += 1;
	}

	return { options, flags };
}

function printHelp(): void {
	console.log(
		[
			"Standalone replay poller (no live CDP required during polling).",
			"",
			"Usage:",
			"  bun scripts/investigation-standalone-replay.ts [options]",
			"",
			"Options:",
			"  --source-log logs/history-poll-15m.ndjson   Captured CDP NDJSON for template bootstrap",
			"  --cookie-header 'SID=...; SAPISID=...'      Optional override for cookie bootstrap",
			"  --repeat 8                                  Number of replay iterations",
			"  --interval-ms 15000                         Delay between iterations",
			"  --warmup-guide-requests 2                   Guide calls before history fetch",
			"  --out logs/standalone-replay.ndjson         Replay NDJSON output",
			"  --state-out logs/standalone-replay-state.json Replay state snapshot",
			"  --rebootstrap-on-auth-failure true          Re-bootstrap from source log after repeated failures",
			"  --max-consecutive-auth-failures 2           Failure threshold before re-bootstrap",
			"  --help                                      Show help",
		].join("\n"),
	);
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

function sanitizeOutputDir(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
}

function findHeaderCaseInsensitive(
	headers: Record<string, string>,
	name: string,
): string | null {
	const normalized = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === normalized) {
			return value;
		}
	}
	return null;
}

function parseCookieJarFromHeader(cookieHeader: string): CookieJar {
	const jar: CookieJar = {};
	for (const part of cookieHeader.split(";")) {
		const trimmed = part.trim();
		if (!trimmed) {
			continue;
		}
		const separator = trimmed.indexOf("=");
		if (separator <= 0) {
			continue;
		}
		const name = trimmed.slice(0, separator).trim();
		const value = trimmed.slice(separator + 1);
		if (!name) {
			continue;
		}
		jar[name] = value;
	}

	if (Object.keys(jar).length === 0) {
		throw new Error("Unable to parse any cookies from cookie header");
	}

	return jar;
}

function buildCookieHeader(cookieJar: CookieJar): string {
	return Object.entries(cookieJar)
		.filter(([name, value]) => name.length > 0 && value.length > 0)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

function extractSetCookieHeaders(headers: Headers): string[] {
	const getter = (headers as Headers & { getSetCookie?: () => string[] })
		.getSetCookie;
	if (typeof getter === "function") {
		return getter.call(headers);
	}

	const merged = headers.get("set-cookie");
	if (!merged) {
		return [];
	}

	return merged.split(/,(?=[^;]+=[^;]+)/g).map((item) => item.trim());
}

function mergeCookieJarFromResponse(
	cookieJar: CookieJar,
	headers: Headers,
	input?: {
		blockCriticalCookieDeletion?: boolean;
	},
): {
	updatedCookieJar: CookieJar;
	setCookieNames: string[];
	deletedCookieNames: string[];
	blockedCriticalDeletionNames: string[];
} {
	const updated = { ...cookieJar };
	const setCookieNames: string[] = [];
	const deletedCookieNames: string[] = [];
	const blockedCriticalDeletionNames: string[] = [];

	for (const setCookie of extractSetCookieHeaders(headers)) {
		const firstSection = setCookie.split(";", 1)[0];
		if (!firstSection) {
			continue;
		}
		const separator = firstSection.indexOf("=");
		if (separator <= 0) {
			continue;
		}
		const name = firstSection.slice(0, separator).trim();
		const value = firstSection.slice(separator + 1);
		if (!name) {
			continue;
		}
		setCookieNames.push(name);

		const lower = setCookie.toLowerCase();
		const maxAgeMatch = lower.match(/max-age=([-\d]+)/);
		const isDeleteByMaxAge = maxAgeMatch
			? Number.parseInt(maxAgeMatch[1] ?? "0", 10) <= 0
			: false;
		const isDeleteByExpires = /expires=thu,\s*01\s*jan\s*1970/i.test(setCookie);
		const shouldDelete =
			value.length === 0 || isDeleteByMaxAge || isDeleteByExpires;

		if (shouldDelete) {
			if (
				input?.blockCriticalCookieDeletion &&
				CRITICAL_AUTH_COOKIES.has(name)
			) {
				blockedCriticalDeletionNames.push(name);
				continue;
			}
			delete updated[name];
			deletedCookieNames.push(name);
			continue;
		}

		updated[name] = value;
	}

	return {
		updatedCookieJar: updated,
		setCookieNames,
		deletedCookieNames,
		blockedCriticalDeletionNames,
	};
}

function buildSapisidHashToken(input: {
	tokenName: string;
	secret: string;
	timestamp: number;
}): string {
	const digest = createHash("sha1")
		.update(`${input.timestamp} ${input.secret} ${ORIGIN}`)
		.digest("hex");
	return `${input.tokenName} ${input.timestamp}_${digest}_u`;
}

function computeSapisidHashAuth(cookieJar: CookieJar): string {
	const timestamp = Math.floor(Date.now() / 1000);
	const primary = cookieJar.SAPISID ?? cookieJar.APISID;
	const firstParty = cookieJar["__Secure-1PAPISID"] ?? primary;
	const thirdParty = cookieJar["__Secure-3PAPISID"] ?? primary;

	if (!primary) {
		throw new Error("Missing SAPISID/APISID cookie required for auth signing");
	}

	const tokens = [
		buildSapisidHashToken({
			tokenName: "SAPISIDHASH",
			secret: primary,
			timestamp,
		}),
	];

	if (firstParty) {
		tokens.push(
			buildSapisidHashToken({
				tokenName: "SAPISID1PHASH",
				secret: firstParty,
				timestamp,
			}),
		);
	}

	if (thirdParty) {
		tokens.push(
			buildSapisidHashToken({
				tokenName: "SAPISID3PHASH",
				secret: thirdParty,
				timestamp,
			}),
		);
	}

	return tokens.join(" ");
}

function countVideosHintInHtml(html: string): number {
	const matches = html.match(/"videoRenderer"/g);
	return matches ? matches.length : 0;
}

function looksLikeAuthOrConsentPage(html: string): boolean {
	const hasSignin = /\bSign in\b/i.test(html);
	const hasAuthFlowMarker =
		/ServiceLogin|accounts\.google\.com\/signin|consent\.youtube\.com/i.test(
			html,
		);
	return hasSignin && hasAuthFlowMarker;
}

function hasExplicitAuthFlowMarkers(html: string): boolean {
	return /accounts\.google\.com\/signin|consent\.youtube\.com|ServiceLogin/i.test(
		html,
	);
}

async function loadReplayTemplate(input: {
	sourceLogPath: string;
	overrideCookieHeader?: string;
}): Promise<ReplayTemplate> {
	const raw = await readFile(input.sourceLogPath, "utf8");
	const rows = raw
		.split(/\n+/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as CapturedRow);

	if (rows.length === 0) {
		throw new Error(`No rows found in ${input.sourceLogPath}`);
	}

	let selectedRequest: CapturedRequest | null = null;
	for (let index = rows.length - 1; index >= 0; index -= 1) {
		const row = rows[index];
		const requests = row?.network?.requests ?? [];
		for (const request of requests) {
			if (
				request.url.includes("/youtubei/v1/guide") &&
				(request.hasAuthorization || request.hasSapisidHashAuth)
			) {
				selectedRequest = request;
				break;
			}
		}
		if (selectedRequest) {
			break;
		}
	}

	if (!selectedRequest) {
		throw new Error(
			`No auth-bearing /youtubei/v1/guide request found in ${input.sourceLogPath}`,
		);
	}

	const mergedHeaders = {
		...(selectedRequest.requestHeaders ?? {}),
		...(selectedRequest.extraRequestHeaders ?? {}),
	};

	const latestRow = rows[rows.length - 1];
	const ytcfg = latestRow?.state?.ytConfig;
	const cookieHeader =
		input.overrideCookieHeader ??
		process.env.YOUTUBE_COOKIE_HEADER ??
		findHeaderCaseInsensitive(mergedHeaders, "cookie") ??
		"";

	if (!cookieHeader.trim()) {
		throw new Error(
			"Missing cookie bootstrap. Pass --cookie-header or set YOUTUBE_COOKIE_HEADER.",
		);
	}

	const apiKey =
		ytcfg?.innertubeApiKey ??
		findHeaderCaseInsensitive(mergedHeaders, "x-youtube-api-key") ??
		"";
	if (!apiKey) {
		throw new Error("Could not resolve INNERTUBE_API_KEY from capture");
	}

	const clientVersion =
		findHeaderCaseInsensitive(mergedHeaders, "x-youtube-client-version") ??
		ytcfg?.innertubeClientVersion ??
		"";
	if (!clientVersion) {
		throw new Error("Could not resolve X-YouTube-Client-Version from capture");
	}

	return {
		innertubeApiKey: apiKey,
		innertubeClientVersion: clientVersion,
		sessionIndex:
			findHeaderCaseInsensitive(mergedHeaders, "x-goog-authuser") ??
			ytcfg?.sessionIndex ??
			"0",
		visitorData:
			findHeaderCaseInsensitive(mergedHeaders, "x-goog-visitor-id") ??
			ytcfg?.visitorData ??
			null,
		xYoutubeClientName:
			findHeaderCaseInsensitive(mergedHeaders, "x-youtube-client-name") ?? "1",
		xYoutubeClientVersion: clientVersion,
		xGoogAuthUser:
			findHeaderCaseInsensitive(mergedHeaders, "x-goog-authuser") ??
			ytcfg?.sessionIndex ??
			"0",
		xGoogPageId: findHeaderCaseInsensitive(mergedHeaders, "x-goog-pageid"),
		userAgent:
			findHeaderCaseInsensitive(mergedHeaders, "user-agent") ??
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
		acceptLanguage:
			findHeaderCaseInsensitive(mergedHeaders, "accept-language") ??
			"en-US,en;q=0.9",
		cookieHeader,
	};
}

async function executeGuideRequest(input: {
	replayTemplate: ReplayTemplate;
	cookieJar: CookieJar;
}): Promise<{
	response: Response;
	cookieMerge: ReturnType<typeof mergeCookieJarFromResponse>;
	authorization: string;
}> {
	const authorization = computeSapisidHashAuth(input.cookieJar);
	const youtubeiUrl = `${ORIGIN}/youtubei/v1/guide?prettyPrint=false&key=${encodeURIComponent(input.replayTemplate.innertubeApiKey)}`;
	const response = await fetch(youtubeiUrl, {
		method: "POST",
		headers: {
			accept: "*/*",
			"accept-language": input.replayTemplate.acceptLanguage,
			"content-type": "application/json",
			origin: ORIGIN,
			referer: `${ORIGIN}/`,
			"user-agent": input.replayTemplate.userAgent,
			cookie: buildCookieHeader(input.cookieJar),
			authorization,
			"x-origin": ORIGIN,
			"x-goog-authuser": input.replayTemplate.xGoogAuthUser,
			...(input.replayTemplate.visitorData
				? { "x-goog-visitor-id": input.replayTemplate.visitorData }
				: {}),
			...(input.replayTemplate.xGoogPageId
				? { "x-goog-pageid": input.replayTemplate.xGoogPageId }
				: {}),
			"x-youtube-client-name": input.replayTemplate.xYoutubeClientName,
			"x-youtube-client-version": input.replayTemplate.xYoutubeClientVersion,
		},
		body: JSON.stringify({
			context: {
				client: {
					clientName: "WEB",
					clientVersion: input.replayTemplate.innertubeClientVersion,
					hl: "en",
					gl: "US",
					...(input.replayTemplate.visitorData
						? { visitorData: input.replayTemplate.visitorData }
						: {}),
				},
				user: {
					lockedSafetyMode: false,
				},
				request: {
					useSsl: true,
				},
			},
		}),
	});

	const cookieMerge = mergeCookieJarFromResponse(
		input.cookieJar,
		response.headers,
		{
			blockCriticalCookieDeletion: true,
		},
	);

	return { response, cookieMerge, authorization };
}

async function main() {
	const parsed = parseCliArgs(process.argv.slice(2));
	if (parsed.flags.has("help")) {
		printHelp();
		return;
	}

	const args = cliSchema.parse({
		sourceLog: parsed.options["source-log"],
		out: parsed.options.out,
		stateOut: parsed.options["state-out"],
		repeat: parsed.options.repeat,
		intervalMs: parsed.options["interval-ms"],
		warmupGuideRequests: parsed.options["warmup-guide-requests"],
		minVideosHint: parsed.options["min-videos-hint"],
		cookieHeader: parsed.options["cookie-header"],
		rebootstrapOnAuthFailure: parsed.options["rebootstrap-on-auth-failure"],
		maxConsecutiveAuthFailures: parsed.options["max-consecutive-auth-failures"],
	});

	sanitizeOutputDir(args.out);
	sanitizeOutputDir(args.stateOut);

	const template = await loadReplayTemplate({
		sourceLogPath: args.sourceLog,
		overrideCookieHeader: args.cookieHeader,
	});

	let replayTemplate = template;
	let cookieJar = parseCookieJarFromHeader(replayTemplate.cookieHeader);
	let lastKnownGoodCookieJar = { ...cookieJar };
	let consecutiveAuthFailures = 0;

	console.log(
		`[standalone-replay] repeat=${args.repeat} interval_ms=${args.intervalMs} out=${args.out}`,
	);

	for (let iteration = 1; iteration <= args.repeat; iteration += 1) {
		const startedAt = Date.now();
		const cookieJarBeforeIteration = { ...cookieJar };
		let rebootstrapApplied = false;
		let rolledBackToLastGood = false;
		try {
			computeSapisidHashAuth(cookieJar);
		} catch (error) {
			if (!args.rebootstrapOnAuthFailure) {
				throw error;
			}

			const refreshedTemplate = await loadReplayTemplate({
				sourceLogPath: args.sourceLog,
				overrideCookieHeader: args.cookieHeader,
			});
			replayTemplate = refreshedTemplate;
			cookieJar = parseCookieJarFromHeader(replayTemplate.cookieHeader);
			rebootstrapApplied = true;
			computeSapisidHashAuth(cookieJar);
		}

		const youtubeiStatuses: number[] = [];
		const youtubeiSetCookieNames = new Set<string>();
		const youtubeiBlockedCriticalDeletionNames = new Set<string>();

		for (
			let warmupIndex = 0;
			warmupIndex < args.warmupGuideRequests;
			warmupIndex += 1
		) {
			const guide = await executeGuideRequest({
				replayTemplate,
				cookieJar,
			});
			youtubeiStatuses.push(guide.response.status);
			for (const name of guide.cookieMerge.setCookieNames) {
				youtubeiSetCookieNames.add(name);
			}
			for (const name of guide.cookieMerge.blockedCriticalDeletionNames) {
				youtubeiBlockedCriticalDeletionNames.add(name);
			}
			cookieJar = guide.cookieMerge.updatedCookieJar;
		}

		const historyResponse = await fetch(HISTORY_URL, {
			headers: {
				accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
				"accept-language": replayTemplate.acceptLanguage,
				"cache-control": "no-cache",
				pragma: "no-cache",
				"sec-fetch-dest": "document",
				"sec-fetch-mode": "navigate",
				"sec-fetch-site": "none",
				"sec-fetch-user": "?1",
				"upgrade-insecure-requests": "1",
				"user-agent": replayTemplate.userAgent,
				cookie: buildCookieHeader(cookieJar),
			},
			redirect: "follow",
		});

		const historyHtml = await historyResponse.text();
		const historyCookieMerge = mergeCookieJarFromResponse(
			cookieJar,
			historyResponse.headers,
			{ blockCriticalCookieDeletion: true },
		);

		const looksAuthPage = looksLikeAuthOrConsentPage(historyHtml);
		const hasExplicitAuthFlow = hasExplicitAuthFlowMarkers(historyHtml);
		const hasCriticalCookieDeletion =
			historyCookieMerge.deletedCookieNames.some((name) =>
				CRITICAL_AUTH_COOKIES.has(name),
			);
		if (!looksAuthPage && !hasExplicitAuthFlow && !hasCriticalCookieDeletion) {
			cookieJar = historyCookieMerge.updatedCookieJar;
		}
		const titleMatch = historyHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
		const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "";
		const videoCountHint = countVideosHintInHtml(historyHtml);
		const hasUsableHistorySignal =
			videoCountHint >= args.minVideosHint || /watch history/i.test(title);
		let softRecoveryApplied = false;
		let authenticated =
			youtubeiStatuses.every((status) => status >= 200 && status < 400) &&
			historyResponse.ok &&
			hasUsableHistorySignal &&
			!(hasExplicitAuthFlow && videoCountHint === 0);

		let activeHistoryStatus = historyResponse.status;
		let activeHistoryTitle = title;
		let activeLooksAuthPage = looksAuthPage;
		let activeHasExplicitAuthFlow = hasExplicitAuthFlow;
		let activeHasCriticalCookieDeletion = hasCriticalCookieDeletion;
		let activeVideoCountHint = videoCountHint;
		let activeHistorySetCookieNames = [...historyCookieMerge.setCookieNames];
		let activeHistoryDeletedCookieNames = [
			...historyCookieMerge.deletedCookieNames,
		];
		let activeHistoryBlockedCriticalDeletionNames = [
			...historyCookieMerge.blockedCriticalDeletionNames,
		];

		if (
			!authenticated &&
			(hasExplicitAuthFlow || looksAuthPage || videoCountHint === 0)
		) {
			softRecoveryApplied = true;
			cookieJar = { ...lastKnownGoodCookieJar };
			const recoveryGuide = await executeGuideRequest({
				replayTemplate,
				cookieJar,
			});
			youtubeiStatuses.push(recoveryGuide.response.status);
			for (const name of recoveryGuide.cookieMerge.setCookieNames) {
				youtubeiSetCookieNames.add(name);
			}
			for (const name of recoveryGuide.cookieMerge
				.blockedCriticalDeletionNames) {
				youtubeiBlockedCriticalDeletionNames.add(name);
			}
			cookieJar = recoveryGuide.cookieMerge.updatedCookieJar;

			const retryHistoryResponse = await fetch(HISTORY_URL, {
				headers: {
					accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
					"accept-language": replayTemplate.acceptLanguage,
					"cache-control": "no-cache",
					pragma: "no-cache",
					"sec-fetch-dest": "document",
					"sec-fetch-mode": "navigate",
					"sec-fetch-site": "none",
					"sec-fetch-user": "?1",
					"upgrade-insecure-requests": "1",
					"user-agent": replayTemplate.userAgent,
					cookie: buildCookieHeader(cookieJar),
				},
				redirect: "follow",
			});
			const retryHistoryHtml = await retryHistoryResponse.text();
			const retryHistoryCookieMerge = mergeCookieJarFromResponse(
				cookieJar,
				retryHistoryResponse.headers,
				{ blockCriticalCookieDeletion: true },
			);
			const retryLooksAuthPage = looksLikeAuthOrConsentPage(retryHistoryHtml);
			const retryHasExplicitAuthFlow =
				hasExplicitAuthFlowMarkers(retryHistoryHtml);
			const retryHasCriticalCookieDeletion =
				retryHistoryCookieMerge.deletedCookieNames.some((name) =>
					CRITICAL_AUTH_COOKIES.has(name),
				);
			if (
				!retryLooksAuthPage &&
				!retryHasExplicitAuthFlow &&
				!retryHasCriticalCookieDeletion
			) {
				cookieJar = retryHistoryCookieMerge.updatedCookieJar;
			}
			const retryTitleMatch = retryHistoryHtml.match(
				/<title[^>]*>([\s\S]*?)<\/title>/i,
			);
			const retryTitle =
				retryTitleMatch?.[1]?.replace(/\s+/g, " ").trim() ?? "";
			const retryVideoCountHint = countVideosHintInHtml(retryHistoryHtml);
			const retryHasUsableHistorySignal =
				retryVideoCountHint >= args.minVideosHint ||
				/watch history/i.test(retryTitle);
			authenticated =
				youtubeiStatuses.every((status) => status >= 200 && status < 400) &&
				retryHistoryResponse.ok &&
				retryHasUsableHistorySignal &&
				!(retryHasExplicitAuthFlow && retryVideoCountHint === 0);

			activeHistoryStatus = retryHistoryResponse.status;
			activeHistoryTitle = retryTitle;
			activeLooksAuthPage = retryLooksAuthPage;
			activeHasExplicitAuthFlow = retryHasExplicitAuthFlow;
			activeHasCriticalCookieDeletion = retryHasCriticalCookieDeletion;
			activeVideoCountHint = retryVideoCountHint;
			activeHistorySetCookieNames = [...retryHistoryCookieMerge.setCookieNames];
			activeHistoryDeletedCookieNames = [
				...retryHistoryCookieMerge.deletedCookieNames,
			];
			activeHistoryBlockedCriticalDeletionNames = [
				...retryHistoryCookieMerge.blockedCriticalDeletionNames,
			];
		}

		if (authenticated) {
			consecutiveAuthFailures = 0;
			lastKnownGoodCookieJar = { ...cookieJar };
		} else {
			consecutiveAuthFailures += 1;
			cookieJar = { ...lastKnownGoodCookieJar };
			rolledBackToLastGood = true;
		}

		if (
			args.rebootstrapOnAuthFailure &&
			consecutiveAuthFailures >= args.maxConsecutiveAuthFailures
		) {
			const refreshedTemplate = await loadReplayTemplate({
				sourceLogPath: args.sourceLog,
				overrideCookieHeader: args.cookieHeader,
			});
			replayTemplate = refreshedTemplate;
			cookieJar = parseCookieJarFromHeader(replayTemplate.cookieHeader);
			rebootstrapApplied = true;
			consecutiveAuthFailures = 0;
		}

		const durationMs = Date.now() - startedAt;
		const entry = {
			timestamp: new Date().toISOString(),
			iteration,
			durationMs,
			authenticated,
			rebootstrapApplied,
			rolledBackToLastGood,
			consecutiveAuthFailures,
			youtubei: {
				statuses: youtubeiStatuses,
				status: youtubeiStatuses.at(-1) ?? null,
				setCookieNames: Array.from(youtubeiSetCookieNames),
				blockedCriticalDeletionNames: Array.from(
					youtubeiBlockedCriticalDeletionNames,
				),
				hasSapisidHashAuthorization: true,
			},
			history: {
				status: activeHistoryStatus,
				title: activeHistoryTitle,
				looksAuthPage: activeLooksAuthPage,
				hasExplicitAuthFlow: activeHasExplicitAuthFlow,
				hasCriticalCookieDeletion: activeHasCriticalCookieDeletion,
				videoCountHint: activeVideoCountHint,
				setCookieNames: activeHistorySetCookieNames,
				deletedCookieNames: activeHistoryDeletedCookieNames,
				blockedCriticalDeletionNames: activeHistoryBlockedCriticalDeletionNames,
				softRecoveryApplied,
			},
			cookies: {
				count: Object.keys(cookieJar).length,
				names: Object.keys(cookieJar).sort(),
				restoredFromLastGood: rolledBackToLastGood,
				changedThisIteration:
					buildCookieHeader(cookieJarBeforeIteration) !==
					buildCookieHeader(cookieJar),
			},
		};

		await appendFile(args.out, `${JSON.stringify(entry)}\n`, "utf8");
		await writeFile(
			args.stateOut,
			`${JSON.stringify(
				{
					timestamp: entry.timestamp,
					authenticated: entry.authenticated,
					iteration: entry.iteration,
					rebootstrapApplied: entry.rebootstrapApplied,
					rolledBackToLastGood: entry.rolledBackToLastGood,
					consecutiveAuthFailures: entry.consecutiveAuthFailures,
					cookies: entry.cookies,
					history: entry.history,
					youtubei: {
						status: entry.youtubei.status,
						hasSapisidHashAuthorization:
							entry.youtubei.hasSapisidHashAuthorization,
					},
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		console.log(
			[
				`iter=${iteration}`,
				`duration_ms=${durationMs}`,
				`auth=${authenticated}`,
				`rebootstrap=${rebootstrapApplied}`,
				`rollback=${rolledBackToLastGood}`,
				`soft_recovery=${softRecoveryApplied}`,
				`youtubei_status=${youtubeiStatuses.at(-1) ?? "-"}`,
				`history_status=${activeHistoryStatus}`,
				`videos_hint=${activeVideoCountHint}`,
				`title=${JSON.stringify(activeHistoryTitle || "-")}`,
			].join(" "),
		);

		if (iteration < args.repeat && args.intervalMs > 0) {
			await sleep(args.intervalMs);
		}
	}
}

await main();
