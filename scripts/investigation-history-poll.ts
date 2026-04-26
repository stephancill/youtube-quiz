import { mkdirSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

type ParsedCliArgs = {
	options: Record<string, string>;
	flags: Set<string>;
};

type CdpEvent = {
	method: string;
	params?: unknown;
	sessionId?: string;
};

type ProbeVideo = {
	id: string;
	title: string;
	channelTitle: string;
	publishedAt: string;
	watchedRatio: number;
};

type ProbeResult = {
	ready: boolean;
	url: string;
	title: string;
	hasSignin: boolean;
	hasServiceLogin: boolean;
	hasAccountsGoogleSignin: boolean;
	hasConsentYoutube: boolean;
	cookieNames: string[];
	localStorageKeys: string[];
	sessionStorageKeys: string[];
	requiredState: Record<string, string | null>;
	ytConfig: {
		innertubeApiKey: string | null;
		innertubeClientName: string | null;
		innertubeClientVersion: string | null;
		visitorData: string | null;
		sessionIndex: string | null;
		delegatedSessionId: string | null;
	};
	videos: ProbeVideo[];
};

type CapturedNetworkRequest = {
	requestId: string;
	url: string;
	method: string;
	resourceType: string | null;
	requestHeaders: Record<string, string>;
	extraRequestHeaders: Record<string, string>;
	hasAuthorization: boolean;
	authorizationHeader: string | null;
	hasSapisidHashAuth: boolean;
	xGoogHeaders: Record<string, string>;
	responseStatus: number | null;
	responseHeaders: Record<string, string>;
	extraResponseHeaders: Record<string, string>;
	setCookieNames: string[];
	failedReason: string | null;
};

type MutableNetworkRequest = {
	requestId: string;
	url: string;
	method: string;
	resourceType: string | null;
	requestHeaders: Record<string, string>;
	extraRequestHeaders: Record<string, string>;
	responseStatus: number | null;
	responseHeaders: Record<string, string>;
	extraResponseHeaders: Record<string, string>;
	failedReason: string | null;
};

type ActiveNetworkCapture = {
	startedAtMs: number;
	requestsById: Map<string, MutableNetworkRequest>;
};

type PollLogEntry = {
	timestamp: string;
	iteration: number;
	durationMs: number;
	authenticated: boolean;
	authReason: string;
	page: {
		url: string;
		title: string;
	};
	markers: {
		hasSignin: boolean;
		hasServiceLogin: boolean;
		hasAccountsGoogleSignin: boolean;
		hasConsentYoutube: boolean;
	};
	cookies: {
		count: number;
		names: string[];
	};
	state: {
		localStorageKeys: string[];
		sessionStorageKeys: string[];
		requiredState: Record<string, string | null>;
		ytConfig: ProbeResult["ytConfig"];
	};
	network: {
		requestCount: number;
		requests: CapturedNetworkRequest[];
	};
	videos: ProbeVideo[];
};

const cliSchema = z.object({
	chromeUrl: z.url().default("http://127.0.0.1:9222"),
	intervalMs: z.coerce.number().int().min(0).default(60_000),
	repeat: z.coerce.number().int().min(0).default(0),
	maxResults: z.coerce.number().int().min(1).max(50).default(8),
	minWatchRatio: z.coerce.number().min(0).max(1).default(0.75),
	pageLoadTimeoutMs: z.coerce.number().int().min(1_000).default(20_000),
	readyTimeoutMs: z.coerce.number().int().min(1_000).default(15_000),
	out: z.string().min(1).default("logs/history-poll.ndjson"),
	stateOut: z.string().min(1).nullable().default(null),
	keepTab: z.boolean().default(false),
});

const CDP_CONNECT_TIMEOUT_MS = 8_000;
const PROBE_POLL_INTERVAL_MS = 500;
const HISTORY_URL = "https://www.youtube.com/feed/history";
const NETWORK_CAPTURE_LIMIT = 30;
const BROWSER_VISIBLE_AUTH_COOKIES = new Set([
	"APISID",
	"SAPISID",
	"SID",
	"SIDCC",
	"__Secure-1PAPISID",
	"__Secure-3PAPISID",
]);

const AUTH_RELATED_HEADERS = new Set([
	"authorization",
	"x-goog-authuser",
	"x-goog-pageid",
	"x-origin",
	"x-youtube-client-name",
	"x-youtube-client-version",
]);

function parseCliArgs(argv: string[]): ParsedCliArgs {
	const options: Record<string, string> = {};
	const flags = new Set<string>();

	for (let index = 0; index < argv.length; index += 1) {
		const current = argv[index];
		if (!current || !current.startsWith("--")) {
			continue;
		}

		const key = current.slice(2);
		const maybeValue = argv[index + 1];
		if (!maybeValue || maybeValue.startsWith("--")) {
			flags.add(key);
			continue;
		}

		options[key] = maybeValue;
		index += 1;
	}

	return { options, flags };
}

function printHelp(): void {
	console.log(
		[
			"Continuously polls YouTube watch history through a real Chrome session (CDP).",
			"",
			"Usage:",
			"  bun scripts/investigation-history-poll.ts [options]",
			"",
			"Options:",
			"  --chrome-url http://127.0.0.1:9222   Chrome DevTools endpoint",
			"  --interval-ms 60000                   Delay between polls",
			"  --repeat 0                            0 = run forever",
			"  --max 8                               Max videos per poll in output",
			"  --min-watch-ratio 0.75                Min watch ratio [0..1]",
			"  --page-load-timeout-ms 20000          Page load timeout",
			"  --ready-timeout-ms 15000              Wait for usable history data",
			"  --out logs/history-poll.ndjson        NDJSON poll log file",
			"  --state-out logs/history-state.json   Write latest state snapshot",
			"  --keep-tab                            Keep Chrome tab open at exit",
			"  --help                                Show this message",
		].join("\n"),
	);
}

function wait(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

function raceWithTimeout<T>(input: {
	promise: Promise<T>;
	timeoutMs: number;
	errorMessage: string;
}): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			reject(new Error(input.errorMessage));
		}, input.timeoutMs);

		input.promise
			.then((value) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeout);
				resolve(value);
			})
			.catch((error) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeout);
				reject(error);
			});
	});
}

function createWebSocketConnection(url: string): Promise<WebSocket> {
	return raceWithTimeout({
		promise: new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			const onOpen = () => {
				cleanup();
				resolve(ws);
			};
			const onError = (event: Event) => {
				cleanup();
				reject(new Error(`WebSocket connection failed: ${event.type}`));
			};
			const onClose = () => {
				cleanup();
				reject(new Error("WebSocket closed before opening"));
			};

			const cleanup = () => {
				ws.removeEventListener("open", onOpen);
				ws.removeEventListener("error", onError);
				ws.removeEventListener("close", onClose);
			};

			ws.addEventListener("open", onOpen);
			ws.addEventListener("error", onError);
			ws.addEventListener("close", onClose);
		}),
		timeoutMs: CDP_CONNECT_TIMEOUT_MS,
		errorMessage: `Timed out connecting to CDP websocket: ${url}`,
	});
}

function createCdpClient(ws: WebSocket) {
	let nextId = 1;
	const pending = new Map<
		number,
		{
			resolve: (result: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	const listeners = new Set<(event: CdpEvent) => void>();

	const onMessage = (event: MessageEvent) => {
		if (typeof event.data !== "string") {
			return;
		}

		let payload: unknown;
		try {
			payload = JSON.parse(event.data);
		} catch {
			return;
		}

		if (!payload || typeof payload !== "object") {
			return;
		}

		const maybeId = (payload as { id?: unknown }).id;
		if (typeof maybeId === "number") {
			const resolver = pending.get(maybeId);
			if (!resolver) {
				return;
			}
			pending.delete(maybeId);

			const maybeError = (payload as { error?: { message?: unknown } }).error;
			if (maybeError) {
				const message =
					typeof maybeError.message === "string"
						? maybeError.message
						: "Unknown CDP error";
				resolver.reject(new Error(message));
				return;
			}

			resolver.resolve((payload as { result?: unknown }).result);
			return;
		}

		const method = (payload as { method?: unknown }).method;
		if (typeof method !== "string") {
			return;
		}

		const eventPayload: CdpEvent = {
			method,
			params: (payload as { params?: unknown }).params,
			sessionId:
				typeof (payload as { sessionId?: unknown }).sessionId === "string"
					? ((payload as { sessionId?: string }).sessionId ?? undefined)
					: undefined,
		};

		for (const listener of listeners) {
			listener(eventPayload);
		}
	};

	const onClose = () => {
		for (const [id, resolver] of pending) {
			resolver.reject(new Error(`CDP websocket closed (pending id: ${id})`));
		}
		pending.clear();
	};

	ws.addEventListener("message", onMessage);
	ws.addEventListener("close", onClose);

	const send = async <T>(input: {
		method: string;
		params?: Record<string, unknown>;
		sessionId?: string;
	}): Promise<T> => {
		const id = nextId;
		nextId += 1;

		const payload: Record<string, unknown> = {
			id,
			method: input.method,
			params: input.params ?? {},
		};
		if (input.sessionId) {
			payload.sessionId = input.sessionId;
		}

		const result = await new Promise<unknown>((resolve, reject) => {
			pending.set(id, {
				resolve,
				reject,
			});
			ws.send(JSON.stringify(payload));
		});

		return result as T;
	};

	const waitForEvent = async (input: {
		method: string;
		sessionId?: string;
		timeoutMs: number;
		predicate?: (event: CdpEvent) => boolean;
	}): Promise<CdpEvent> => {
		return raceWithTimeout({
			promise: new Promise((resolve) => {
				const listener = (event: CdpEvent) => {
					if (event.method !== input.method) {
						return;
					}
					if (input.sessionId && event.sessionId !== input.sessionId) {
						return;
					}
					if (input.predicate && !input.predicate(event)) {
						return;
					}

					listeners.delete(listener);
					resolve(event);
				};

				listeners.add(listener);
			}),
			timeoutMs: input.timeoutMs,
			errorMessage: `Timed out waiting for CDP event ${input.method}`,
		});
	};

	const subscribe = (listener: (event: CdpEvent) => void): (() => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};

	const close = () => {
		ws.removeEventListener("message", onMessage);
		ws.removeEventListener("close", onClose);
		if (
			ws.readyState === WebSocket.OPEN ||
			ws.readyState === WebSocket.CONNECTING
		) {
			ws.close();
		}
	};

	return {
		send,
		waitForEvent,
		subscribe,
		close,
	};
}

async function evaluateInSession<T>(input: {
	send: ReturnType<typeof createCdpClient>["send"];
	sessionId: string;
	expression: string;
}): Promise<T> {
	const result = await input.send<{
		result?: {
			type?: string;
			value?: unknown;
			description?: string;
		};
		exceptionDetails?: {
			text?: string;
			exception?: { description?: string };
		};
	}>({
		method: "Runtime.evaluate",
		sessionId: input.sessionId,
		params: {
			expression: input.expression,
			awaitPromise: true,
			returnByValue: true,
		},
	});

	if (result.exceptionDetails) {
		const details = result.exceptionDetails;
		const message =
			details.exception?.description ??
			details.text ??
			"Runtime.evaluate failed";
		throw new Error(message);
	}

	return (result.result?.value ?? null) as T;
}

function createPageProbeExpression(maxResults: number): string {
	return String.raw`(() => {
	const limit = ${JSON.stringify(maxResults)};
	const requiredStateKeys = [
		"DELEGATED_SESSION_ID",
		"SESSION_INDEX",
		"VISITOR_INFO1_LIVE",
		"VISITOR_PRIVACY_METADATA",
		"yt-remote-device-id",
		"yt-player-headers-readable",
	];
	const getStore = (store) => {
		const values = Object.create(null);
		for (const key of requiredStateKeys) {
			values[key] = store.getItem(key);
		}
		return values;
	};
	const localState = getStore(window.localStorage);
	const sessionState = getStore(window.sessionStorage);
	const requiredState = Object.assign(Object.create(null), localState, sessionState);

	const ytcfgData = window.ytcfg?.data_ ?? {};
	const getConfigString = (key) => {
		const value = ytcfgData[key];
		return typeof value === "string" ? value : null;
	};

	const percentToRatio = (percent) => {
		if (typeof percent !== "number" || Number.isNaN(percent)) {
			return 0;
		}
		return Math.max(0, Math.min(100, percent)) / 100;
	};
	const parseClockDurationToSeconds = (value) => {
		if (!value) return 0;
		const parts = value.split(":").map((part) => Number.parseInt(part.trim(), 10));
		if (parts.some((part) => Number.isNaN(part))) return 0;
		if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
		if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
		return 0;
	};
	const parseRelativeTimeToIso = (value) => {
		const normalized = String(value).toLowerCase();
		const now = Date.now();
		const match = normalized.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?/);
		if (!match) {
			if (normalized.includes("yesterday")) return new Date(now - 24 * 60 * 60 * 1000).toISOString();
			return new Date(now).toISOString();
		}
		const amount = Number.parseInt(match[1] ?? "0", 10);
		const unit = match[2] ?? "second";
		const factors = { second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 };
		return new Date(now - amount * (factors[unit] ?? 0)).toISOString();
	};

	const extractVideos = (data) => {
		const MIN_SECONDS = 300;
		const stack = [data];
		const seen = new Set();
		const videos = [];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current || typeof current !== "object") continue;
			if (current.videoRenderer && typeof current.videoRenderer === "object") {
				const video = current.videoRenderer;
				const videoId = typeof video.videoId === "string" ? video.videoId : null;
				const title = typeof video.title?.runs?.[0]?.text === "string" ? video.title.runs[0].text : null;
				const channelTitle = typeof video.ownerText?.runs?.[0]?.text === "string" ? video.ownerText.runs[0].text : "Unknown channel";
				const durationSeconds = parseClockDurationToSeconds(typeof video.lengthText?.simpleText === "string" ? video.lengthText.simpleText : null);
				const watchedRatio = percentToRatio(video.thumbnailOverlays?.find((overlay) => Boolean(overlay.thumbnailOverlayResumePlaybackRenderer))?.thumbnailOverlayResumePlaybackRenderer?.percentDurationWatched);
				if (videoId && title && !seen.has(videoId) && durationSeconds >= MIN_SECONDS) {
					seen.add(videoId);
					const publishedText = typeof video.publishedTimeText?.simpleText === "string"
						? video.publishedTimeText.simpleText
						: typeof video.publishedTimeText?.runs?.[0]?.text === "string"
							? video.publishedTimeText.runs[0].text
							: "just now";
					videos.push({ id: videoId, title, channelTitle, publishedAt: parseRelativeTimeToIso(publishedText), watchedRatio });
				}
			}
			if (current.lockupViewModel && typeof current.lockupViewModel === "object") {
				const lockup = current.lockupViewModel;
				const contentType = typeof lockup.contentType === "string" ? lockup.contentType : null;
				const videoId = typeof lockup.contentId === "string" ? lockup.contentId : null;
				const title = typeof lockup.metadata?.lockupMetadataViewModel?.title?.content === "string" ? lockup.metadata.lockupMetadataViewModel.title.content : null;
				const badgeText = typeof lockup.contentImage?.thumbnailViewModel?.overlays?.[0]?.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel?.text === "string"
					? lockup.contentImage.thumbnailViewModel.overlays[0].thumbnailBottomOverlayViewModel.badges[0].thumbnailBadgeViewModel.text
					: null;
				const durationSeconds = parseClockDurationToSeconds(badgeText);
				const watchedRatio = percentToRatio(lockup.contentImage?.thumbnailViewModel?.overlays?.[0]?.thumbnailBottomOverlayViewModel?.progressBar?.thumbnailOverlayProgressBarViewModel?.startPercent);
				const firstRow = lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0];
				const channelTitle = typeof firstRow?.metadataParts?.[0]?.text?.content === "string" ? firstRow.metadataParts[0].text.content : "Unknown channel";
				if (contentType === "LOCKUP_CONTENT_TYPE_VIDEO" && videoId && title && !seen.has(videoId) && durationSeconds >= MIN_SECONDS) {
					seen.add(videoId);
					videos.push({ id: videoId, title, channelTitle, publishedAt: new Date().toISOString(), watchedRatio });
				}
			}
			for (const value of Object.values(current)) {
				stack.push(value);
			}
		}
		videos.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
		return videos.slice(0, limit);
	};

	const html = document.documentElement?.innerHTML ?? "";
	const initialData = window.ytInitialData ?? null;
	const videos = initialData ? extractVideos(initialData) : [];
	const cookieNames = document.cookie
		.split(";")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry) => {
			const index = entry.indexOf("=");
			return index <= 0 ? null : entry.slice(0, index).trim();
		})
		.filter(Boolean);

	const hasSignin = /\bSign in\b/i.test(html);
	const hasServiceLogin = /ServiceLogin/i.test(html);
	const hasAccountsGoogleSignin = /accounts\.google\.com\/signin/i.test(html);
	const hasConsentYoutube = /consent\.youtube\.com/i.test(html);

	return {
		ready: Boolean(initialData) || hasSignin || hasServiceLogin,
		url: location.href,
		title: document.title ?? "",
		hasSignin,
		hasServiceLogin,
		hasAccountsGoogleSignin,
		hasConsentYoutube,
		cookieNames,
		localStorageKeys: Object.keys(window.localStorage),
		sessionStorageKeys: Object.keys(window.sessionStorage),
		requiredState,
		ytConfig: {
			innertubeApiKey: getConfigString("INNERTUBE_API_KEY"),
			innertubeClientName: getConfigString("INNERTUBE_CONTEXT_CLIENT_NAME"),
			innertubeClientVersion: getConfigString("INNERTUBE_CONTEXT_CLIENT_VERSION"),
			visitorData: getConfigString("VISITOR_DATA"),
			sessionIndex: getConfigString("SESSION_INDEX"),
			delegatedSessionId: getConfigString("DELEGATED_SESSION_ID"),
		},
		videos,
	};
})()`;
}

async function fetchBrowserDebuggerUrl(chromeUrl: string): Promise<string> {
	const versionUrl = `${chromeUrl.replace(/\/+$/, "")}/json/version`;
	const response = await fetch(versionUrl);
	if (!response.ok) {
		throw new Error(
			`CDP version endpoint failed (${response.status}): ${versionUrl}`,
		);
	}

	const payload = (await response.json()) as { webSocketDebuggerUrl?: unknown };
	if (typeof payload.webSocketDebuggerUrl !== "string") {
		throw new Error(`webSocketDebuggerUrl missing at: ${versionUrl}`);
	}

	return payload.webSocketDebuggerUrl;
}

async function createHistorySession(input: {
	send: ReturnType<typeof createCdpClient>["send"];
}): Promise<{ targetId: string; sessionId: string }> {
	const target = await input.send<{ targetId?: unknown }>({
		method: "Target.createTarget",
		params: { url: "about:blank" },
	});
	const targetId =
		typeof target.targetId === "string" ? target.targetId : undefined;
	if (!targetId) {
		throw new Error("Target.createTarget did not return a targetId");
	}

	const attached = await input.send<{ sessionId?: unknown }>({
		method: "Target.attachToTarget",
		params: {
			targetId,
			flatten: true,
		},
	});

	const sessionId =
		typeof attached.sessionId === "string" ? attached.sessionId : undefined;
	if (!sessionId) {
		throw new Error("Target.attachToTarget did not return a sessionId");
	}

	await input.send({ method: "Page.enable", sessionId });
	await input.send({ method: "Runtime.enable", sessionId });
	await input.send({ method: "Network.enable", sessionId });
	await input.send({
		method: "Network.setCacheDisabled",
		sessionId,
		params: { cacheDisabled: true },
	});

	return { targetId, sessionId };
}

async function navigateAndProbe(input: {
	send: ReturnType<typeof createCdpClient>["send"];
	waitForEvent: ReturnType<typeof createCdpClient>["waitForEvent"];
	sessionId: string;
	maxResults: number;
	minWatchRatio: number;
	pageLoadTimeoutMs: number;
	readyTimeoutMs: number;
}): Promise<ProbeResult> {
	await input.send({
		method: "Page.navigate",
		sessionId: input.sessionId,
		params: { url: HISTORY_URL },
	});

	await input.waitForEvent({
		method: "Page.loadEventFired",
		sessionId: input.sessionId,
		timeoutMs: input.pageLoadTimeoutMs,
	});

	const probeExpression = createPageProbeExpression(input.maxResults);
	const startedAt = Date.now();
	let lastProbe: ProbeResult | null = null;

	while (Date.now() - startedAt <= input.readyTimeoutMs) {
		const probe = await evaluateInSession<ProbeResult>({
			send: input.send,
			sessionId: input.sessionId,
			expression: probeExpression,
		});
		lastProbe = probe;

		if (probe.ready) {
			break;
		}

		await wait(PROBE_POLL_INTERVAL_MS);
	}

	if (!lastProbe) {
		throw new Error("Page probe returned no data");
	}

	return {
		...lastProbe,
		videos: lastProbe.videos
			.filter((video) => video.watchedRatio >= input.minWatchRatio)
			.slice(0, input.maxResults),
	};
}

function normalizeHeaderRecord(input: unknown): Record<string, string> {
	if (!input || typeof input !== "object") {
		return {};
	}

	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(input)) {
		if (!key) {
			continue;
		}

		if (typeof value === "string") {
			output[key] = value;
			continue;
		}

		if (Array.isArray(value)) {
			output[key] = value
				.filter((entry) => typeof entry === "string")
				.join(", ");
			continue;
		}

		if (typeof value === "number" || typeof value === "boolean") {
			output[key] = String(value);
		}
	}

	return output;
}

function pickInterestingHeaders(
	headers: Record<string, string>,
): Record<string, string> {
	const picked: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (AUTH_RELATED_HEADERS.has(key.toLowerCase())) {
			picked[key] = value;
		}
	}
	return picked;
}

function extractSetCookieNames(headers: Record<string, string>): string[] {
	const names = new Set<string>();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== "set-cookie") {
			continue;
		}

		for (const chunk of value.split(/,(?=[^;]+=[^;]+)/g)) {
			const cookie = chunk.trim().split(";", 1)[0];
			if (!cookie) {
				continue;
			}
			const separator = cookie.indexOf("=");
			if (separator <= 0) {
				continue;
			}
			names.add(cookie.slice(0, separator).trim());
		}
	}

	return Array.from(names);
}

function startNetworkCapture(): ActiveNetworkCapture {
	return {
		startedAtMs: Date.now(),
		requestsById: new Map<string, MutableNetworkRequest>(),
	};
}

function getOrCreateCapturedRequest(input: {
	activeCapture: ActiveNetworkCapture;
	requestId: string;
}): MutableNetworkRequest {
	const existing = input.activeCapture.requestsById.get(input.requestId);
	if (existing) {
		return existing;
	}

	const created: MutableNetworkRequest = {
		requestId: input.requestId,
		url: "",
		method: "",
		resourceType: null,
		requestHeaders: {},
		extraRequestHeaders: {},
		responseStatus: null,
		responseHeaders: {},
		extraResponseHeaders: {},
		failedReason: null,
	};
	input.activeCapture.requestsById.set(input.requestId, created);
	return created;
}

function finalizeNetworkCapture(activeCapture: ActiveNetworkCapture): {
	requestCount: number;
	requests: CapturedNetworkRequest[];
} {
	const entries: CapturedNetworkRequest[] = [];

	for (const request of activeCapture.requestsById.values()) {
		if (
			!request.url.includes("youtube.com") &&
			!request.url.includes("google.com")
		) {
			continue;
		}

		const requestAuthHeaders = pickInterestingHeaders(request.requestHeaders);
		const extraRequestAuthHeaders = pickInterestingHeaders(
			request.extraRequestHeaders,
		);
		const mergedAuthHeaders = {
			...requestAuthHeaders,
			...extraRequestAuthHeaders,
		};
		const authorizationHeader =
			Object.entries(mergedAuthHeaders).find(
				([key]) => key.toLowerCase() === "authorization",
			)?.[1] ?? null;
		const hasSapisidHashAuth =
			typeof authorizationHeader === "string" &&
			/(^|\s)(SAPISIDHASH|APISIDHASH)\s/i.test(authorizationHeader);

		entries.push({
			requestId: request.requestId,
			url: request.url,
			method: request.method,
			resourceType: request.resourceType,
			requestHeaders: request.requestHeaders,
			extraRequestHeaders: request.extraRequestHeaders,
			hasAuthorization: Boolean(authorizationHeader),
			authorizationHeader,
			hasSapisidHashAuth,
			xGoogHeaders: mergedAuthHeaders,
			responseStatus: request.responseStatus,
			responseHeaders: request.responseHeaders,
			extraResponseHeaders: request.extraResponseHeaders,
			setCookieNames: extractSetCookieNames({
				...request.responseHeaders,
				...request.extraResponseHeaders,
			}),
			failedReason: request.failedReason,
		});
	}

	const scoreRequest = (request: CapturedNetworkRequest): number => {
		let score = 0;
		if (request.hasSapisidHashAuth) {
			score += 200;
		}
		if (request.hasAuthorization) {
			score += 120;
		}
		if (request.url.includes("/youtubei/")) {
			score += 90;
		}
		if (request.url.includes("/feed/history")) {
			score += 80;
		}
		if (request.url.includes("youtube.com")) {
			score += 30;
		}
		if (request.url.includes("google.com")) {
			score += 10;
		}
		if (request.failedReason) {
			score += 5;
		}
		return score;
	};

	entries.sort((a, b) => {
		const scoreDelta = scoreRequest(b) - scoreRequest(a);
		if (scoreDelta !== 0) {
			return scoreDelta;
		}
		return a.url.localeCompare(b.url);
	});
	return {
		requestCount: entries.length,
		requests: entries.slice(0, NETWORK_CAPTURE_LIMIT),
	};
}

function formatConsoleLine(input: {
	iteration: number;
	durationMs: number;
	entry: PollLogEntry;
}): string {
	return [
		`iter=${input.iteration}`,
		`duration_ms=${input.durationMs}`,
		`auth=${input.entry.authenticated}`,
		`auth_reason=${input.entry.authReason}`,
		`videos=${input.entry.videos.length}`,
		`cookies=${input.entry.cookies.count}`,
		`title=${JSON.stringify(input.entry.page.title || "-")}`,
	].join(" ");
}

function determineAuthentication(probe: ProbeResult): {
	authenticated: boolean;
	reason: string;
} {
	const title = probe.title.trim().toLowerCase();
	const onWatchHistoryPage =
		probe.url.startsWith(HISTORY_URL) && /watch history/i.test(probe.title);
	const hasVisibleAuthCookie = probe.cookieNames.some((name) =>
		BROWSER_VISIBLE_AUTH_COOKIES.has(name),
	);
	const hasSessionSignals =
		hasVisibleAuthCookie ||
		probe.videos.length > 0 ||
		probe.ytConfig.sessionIndex !== null;

	if (probe.hasAccountsGoogleSignin || probe.hasConsentYoutube) {
		return {
			authenticated: false,
			reason: "explicit_google_auth_flow",
		};
	}

	if (onWatchHistoryPage && hasSessionSignals) {
		return {
			authenticated: true,
			reason: "history_page_with_session_signals",
		};
	}

	if (
		title === "youtube" &&
		probe.hasServiceLogin &&
		!hasSessionSignals &&
		probe.videos.length === 0
	) {
		return {
			authenticated: false,
			reason: "signin_landing_without_session",
		};
	}

	if (hasSessionSignals) {
		return {
			authenticated: true,
			reason: "session_signals_present",
		};
	}

	return {
		authenticated: false,
		reason: "no_session_signals",
	};
}

function sanitizeOutputDir(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
}

async function main() {
	const parsed = parseCliArgs(process.argv.slice(2));

	if (parsed.flags.has("help")) {
		printHelp();
		return;
	}

	const args = cliSchema.parse({
		chromeUrl: parsed.options["chrome-url"],
		intervalMs: parsed.options["interval-ms"],
		repeat: parsed.options.repeat,
		maxResults: parsed.options.max,
		minWatchRatio: parsed.options["min-watch-ratio"],
		pageLoadTimeoutMs: parsed.options["page-load-timeout-ms"],
		readyTimeoutMs: parsed.options["ready-timeout-ms"],
		out: parsed.options.out,
		stateOut: parsed.options["state-out"] ?? null,
		keepTab: parsed.flags.has("keep-tab"),
	});

	sanitizeOutputDir(args.out);
	if (args.stateOut) {
		sanitizeOutputDir(args.stateOut);
	}

	const browserWsUrl = await fetchBrowserDebuggerUrl(args.chromeUrl);
	const ws = await createWebSocketConnection(browserWsUrl);
	const cdp = createCdpClient(ws);

	let targetId: string | null = null;
	let sessionId: string | null = null;
	let unsubscribeCdp: (() => void) | null = null;

	try {
		const session = await createHistorySession({ send: cdp.send });
		targetId = session.targetId;
		sessionId = session.sessionId;

		let activeNetworkCapture: ActiveNetworkCapture | null = null;
		unsubscribeCdp = cdp.subscribe((event) => {
			if (!activeNetworkCapture || event.sessionId !== sessionId) {
				return;
			}

			if (event.method === "Network.requestWillBeSent") {
				const params = (event.params ?? {}) as {
					requestId?: unknown;
					request?: {
						url?: unknown;
						method?: unknown;
						headers?: unknown;
					};
					type?: unknown;
				};
				const requestId =
					typeof params.requestId === "string" ? params.requestId : null;
				if (!requestId) {
					return;
				}

				const item = getOrCreateCapturedRequest({
					activeCapture: activeNetworkCapture,
					requestId,
				});
				item.url =
					typeof params.request?.url === "string"
						? params.request.url
						: item.url;
				item.method =
					typeof params.request?.method === "string"
						? params.request.method
						: item.method;
				item.resourceType =
					typeof params.type === "string" ? params.type : item.resourceType;
				item.requestHeaders = normalizeHeaderRecord(params.request?.headers);
				return;
			}

			if (event.method === "Network.requestWillBeSentExtraInfo") {
				const params = (event.params ?? {}) as {
					requestId?: unknown;
					headers?: unknown;
				};
				const requestId =
					typeof params.requestId === "string" ? params.requestId : null;
				if (!requestId) {
					return;
				}

				const item = getOrCreateCapturedRequest({
					activeCapture: activeNetworkCapture,
					requestId,
				});
				item.extraRequestHeaders = normalizeHeaderRecord(params.headers);
				return;
			}

			if (event.method === "Network.responseReceived") {
				const params = (event.params ?? {}) as {
					requestId?: unknown;
					response?: {
						status?: unknown;
						headers?: unknown;
					};
				};
				const requestId =
					typeof params.requestId === "string" ? params.requestId : null;
				if (!requestId) {
					return;
				}

				const item = getOrCreateCapturedRequest({
					activeCapture: activeNetworkCapture,
					requestId,
				});
				item.responseStatus =
					typeof params.response?.status === "number"
						? params.response.status
						: item.responseStatus;
				item.responseHeaders = normalizeHeaderRecord(params.response?.headers);
				return;
			}

			if (event.method === "Network.responseReceivedExtraInfo") {
				const params = (event.params ?? {}) as {
					requestId?: unknown;
					headers?: unknown;
					statusCode?: unknown;
				};
				const requestId =
					typeof params.requestId === "string" ? params.requestId : null;
				if (!requestId) {
					return;
				}

				const item = getOrCreateCapturedRequest({
					activeCapture: activeNetworkCapture,
					requestId,
				});
				item.extraResponseHeaders = normalizeHeaderRecord(params.headers);
				item.responseStatus =
					typeof params.statusCode === "number"
						? params.statusCode
						: item.responseStatus;
				return;
			}

			if (event.method === "Network.loadingFailed") {
				const params = (event.params ?? {}) as {
					requestId?: unknown;
					errorText?: unknown;
				};
				const requestId =
					typeof params.requestId === "string" ? params.requestId : null;
				if (!requestId) {
					return;
				}

				const item = getOrCreateCapturedRequest({
					activeCapture: activeNetworkCapture,
					requestId,
				});
				item.failedReason =
					typeof params.errorText === "string" ? params.errorText : "unknown";
			}
		});

		console.log(
			`[history-poll] connected chrome=${args.chromeUrl} repeat=${args.repeat} interval_ms=${args.intervalMs} out=${args.out}`,
		);

		let iteration = 0;
		while (args.repeat === 0 || iteration < args.repeat) {
			iteration += 1;
			const startedAt = Date.now();
			activeNetworkCapture = startNetworkCapture();
			const probe = await navigateAndProbe({
				send: cdp.send,
				waitForEvent: cdp.waitForEvent,
				sessionId,
				maxResults: args.maxResults,
				minWatchRatio: args.minWatchRatio,
				pageLoadTimeoutMs: args.pageLoadTimeoutMs,
				readyTimeoutMs: args.readyTimeoutMs,
			});
			const durationMs = Date.now() - startedAt;
			const networkCapture = finalizeNetworkCapture(activeNetworkCapture);
			activeNetworkCapture = null;

			const authState = determineAuthentication(probe);

			const entry: PollLogEntry = {
				timestamp: new Date().toISOString(),
				iteration,
				durationMs,
				authenticated: authState.authenticated,
				authReason: authState.reason,
				page: {
					url: probe.url,
					title: probe.title,
				},
				markers: {
					hasSignin: probe.hasSignin,
					hasServiceLogin: probe.hasServiceLogin,
					hasAccountsGoogleSignin: probe.hasAccountsGoogleSignin,
					hasConsentYoutube: probe.hasConsentYoutube,
				},
				cookies: {
					count: probe.cookieNames.length,
					names: probe.cookieNames,
				},
				state: {
					localStorageKeys: probe.localStorageKeys,
					sessionStorageKeys: probe.sessionStorageKeys,
					requiredState: probe.requiredState,
					ytConfig: probe.ytConfig,
				},
				network: networkCapture,
				videos: probe.videos,
			};

			await appendFile(args.out, `${JSON.stringify(entry)}\n`, "utf8");

			if (args.stateOut) {
				await writeFile(
					args.stateOut,
					`${JSON.stringify(
						{
							timestamp: entry.timestamp,
							authenticated: entry.authenticated,
							authReason: entry.authReason,
							cookies: entry.cookies,
							state: entry.state,
							network: {
								requestCount: entry.network.requestCount,
								authRequestCount: entry.network.requests.filter(
									(request) => request.hasAuthorization,
								).length,
								hasSapisidHashRequest: entry.network.requests.some(
									(request) => request.hasSapisidHashAuth,
								),
							},
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
			}

			console.log(formatConsoleLine({ iteration, durationMs, entry }));

			if (args.repeat !== 0 && iteration >= args.repeat) {
				break;
			}

			if (args.intervalMs > 0) {
				await wait(args.intervalMs);
			}
		}
	} finally {
		if (unsubscribeCdp) {
			unsubscribeCdp();
		}

		if (targetId && !args.keepTab) {
			try {
				await cdp.send({
					method: "Target.closeTarget",
					params: { targetId },
				});
			} catch {
				// Ignore best-effort cleanup errors.
			}
		}

		cdp.close();
	}
}

await main();
