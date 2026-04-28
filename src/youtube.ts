import type { AppDatabase } from "./db";
import type { LinkedUser, YoutubeCookieJar, YoutubeVideo } from "./types";

const MIN_VIDEO_LENGTH_SECONDS = 5 * 60;
const YOUTUBE_ORIGIN = "https://www.youtube.com";
const HISTORY_URL = `${YOUTUBE_ORIGIN}/feed/history`;
const DEFAULT_INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const DEFAULT_CLIENT_VERSION = "2.20260424.01.00";
const DEFAULT_CLIENT_NAME = "1";
const GUIDE_WARMUP_REQUESTS = 2;
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

type CookieJarMergeResult = {
	cookieJar: YoutubeCookieJar;
	stats: {
		added: number;
		updated: number;
		deleted: number;
		addedNames: string[];
		updatedNames: string[];
		deletedNames: string[];
		blockedCriticalDeletionNames: string[];
	};
};

type RuntimeRequestContext = {
	apiKey: string;
	clientVersion: string;
	clientName: string;
	sessionIndex: string;
	visitorData: string | null;
};

export class YoutubeService {
	constructor(private db: AppDatabase) {}

	async validateCookieJar(input: {
		telegramUserId: number;
		cookieJar: YoutubeCookieJar;
	}): Promise<YoutubeCookieJar> {
		let workingCookieJar: YoutubeCookieJar = { ...input.cookieJar };
		console.log(
			`[youtube] user=${input.telegramUserId} validate_start cookie_count=${Object.keys(workingCookieJar).length}`,
		);

		const firstHistoryResponse = await this.fetchHistoryPage(workingCookieJar);
		this.logHistoryResponse({
			telegramUserId: input.telegramUserId,
			stage: "validate_first_history",
			response: firstHistoryResponse.response,
			html: firstHistoryResponse.html,
		});
		if (!firstHistoryResponse.response.ok) {
			throw new Error(
				`YouTube history validation request failed with ${firstHistoryResponse.response.status}`,
			);
		}

		workingCookieJar = this.applyMergedCookieJar(
			workingCookieJar,
			firstHistoryResponse.response.headers,
		);

		const runtimeContext = this.extractRuntimeRequestContext(
			firstHistoryResponse.html,
		);
		workingCookieJar = await this.warmupGuideRequests({
			telegramUserId: input.telegramUserId,
			cookieJar: workingCookieJar,
			runtimeContext,
		});

		const finalHistoryResponse = await this.fetchHistoryPage(workingCookieJar);
		this.logHistoryResponse({
			telegramUserId: input.telegramUserId,
			stage: "validate_final_history",
			response: finalHistoryResponse.response,
			html: finalHistoryResponse.html,
		});
		if (!finalHistoryResponse.response.ok) {
			throw new Error(
				`YouTube history validation request failed with ${finalHistoryResponse.response.status}`,
			);
		}

		workingCookieJar = this.applyMergedCookieJar(
			workingCookieJar,
			finalHistoryResponse.response.headers,
		);

		const ytInitialData = this.extractYtInitialData(finalHistoryResponse.html);
		const videos = this.extractVideosFromHistoryData(ytInitialData);
		const isAuthOrConsentResponse =
			videos.length === 0 &&
			this.looksLikeAuthOrConsentPage(finalHistoryResponse.html);

		if (isAuthOrConsentResponse) {
			this.logAuthOrConsentDiagnostics({
				telegramUserId: input.telegramUserId,
				response: finalHistoryResponse.response,
				html: finalHistoryResponse.html,
			});
			throw new Error(
				"YouTube cookies appear expired or invalid. Please paste a fresh Cookie header from an authenticated YouTube tab.",
			);
		}

		console.log(
			`[youtube] user=${input.telegramUserId} validate_complete videos=${videos.length} cookie_count=${Object.keys(workingCookieJar).length}`,
		);
		return workingCookieJar;
	}

	async listRecentWatchedVideos(
		user: LinkedUser,
		maxResults: number,
		minWatchRatio: number,
	): Promise<YoutubeVideo[]> {
		let workingCookieJar: YoutubeCookieJar = { ...user.youtubeCookieJar };
		console.log(
			`[youtube] user=${user.telegramUserId} fetch_start cookie_count=${Object.keys(workingCookieJar).length} max_results=${maxResults} min_watch_ratio=${minWatchRatio}`,
		);

		const firstHistoryResponse = await this.fetchHistoryPage(workingCookieJar);
		this.logHistoryResponse({
			telegramUserId: user.telegramUserId,
			stage: "first_history",
			response: firstHistoryResponse.response,
			html: firstHistoryResponse.html,
		});
		if (!firstHistoryResponse.response.ok) {
			throw new Error(
				`YouTube history request failed with ${firstHistoryResponse.response.status}`,
			);
		}

		workingCookieJar = this.applyMergedCookieJar(
			workingCookieJar,
			firstHistoryResponse.response.headers,
		);

		const runtimeContext = this.extractRuntimeRequestContext(
			firstHistoryResponse.html,
		);
		console.log(
			`[youtube] user=${user.telegramUserId} runtime_context client_name=${runtimeContext.clientName} client_version=${runtimeContext.clientVersion} session_index=${runtimeContext.sessionIndex} has_visitor_data=${Boolean(runtimeContext.visitorData)}`,
		);
		workingCookieJar = await this.warmupGuideRequests({
			telegramUserId: user.telegramUserId,
			cookieJar: workingCookieJar,
			runtimeContext,
		});

		const finalHistoryResponse = await this.fetchHistoryPage(workingCookieJar);
		this.logHistoryResponse({
			telegramUserId: user.telegramUserId,
			stage: "final_history",
			response: finalHistoryResponse.response,
			html: finalHistoryResponse.html,
		});
		if (!finalHistoryResponse.response.ok) {
			throw new Error(
				`YouTube history request failed with ${finalHistoryResponse.response.status}`,
			);
		}

		workingCookieJar = this.applyMergedCookieJar(
			workingCookieJar,
			finalHistoryResponse.response.headers,
		);

		const html = finalHistoryResponse.html;
		const ytInitialData = this.extractYtInitialData(html);
		const videos = this.extractVideosFromHistoryData(ytInitialData)
			.filter((video) => video.watchedRatio >= minWatchRatio)
			.slice(0, maxResults);
		console.log(
			`[youtube] user=${user.telegramUserId} fetch_complete videos=${videos.length} newest=${videos[0]?.publishedAt ?? "-"}`,
		);
		const isAuthOrConsentResponse =
			videos.length === 0 && this.looksLikeAuthOrConsentPage(html);

		if (isAuthOrConsentResponse) {
			this.logAuthOrConsentDiagnostics({
				telegramUserId: user.telegramUserId,
				response: finalHistoryResponse.response,
				html,
			});
			console.warn(
				`[youtube-cookie-jar] user=${user.telegramUserId} skipped_persist=auth_or_consent_page`,
			);
			throw new Error(
				"YouTube cookies appear expired or invalid. Please run /link and paste a fresh Cookie header.",
			);
		}

		this.persistCookieJarIfSafe({
			telegramUserId: user.telegramUserId,
			originalCookieJar: user.youtubeCookieJar,
			nextCookieJar: workingCookieJar,
		});

		return videos;
	}

	private persistCookieJarIfSafe(input: {
		telegramUserId: number;
		originalCookieJar: YoutubeCookieJar;
		nextCookieJar: YoutubeCookieJar;
	}) {
		if (
			JSON.stringify(input.originalCookieJar) ===
			JSON.stringify(input.nextCookieJar)
		) {
			return;
		}

		const deletedNames = Object.keys(input.originalCookieJar).filter(
			(name) => !(name in input.nextCookieJar),
		);
		const containsCriticalDeletion = deletedNames.some((name) =>
			CRITICAL_AUTH_COOKIES.has(name),
		);

		if (containsCriticalDeletion) {
			console.warn(
				`[youtube-cookie-jar] user=${input.telegramUserId} skipped_persist=critical_cookie_deletions deleted_names=${deletedNames.join(",") || "-"}`,
			);
			return;
		}

		this.db.saveYoutubeCookieJar(input.telegramUserId, input.nextCookieJar);
		console.log(
			`[youtube-cookie-jar] user=${input.telegramUserId} persisted total=${Object.keys(input.nextCookieJar).length} deleted_names=${deletedNames.join(",") || "-"}`,
		);
	}

	private async fetchHistoryPage(cookieJar: YoutubeCookieJar): Promise<{
		response: Response;
		html: string;
	}> {
		const cookieHeader = this.buildCookieHeader(cookieJar);
		const response = await fetch(HISTORY_URL, {
			headers: {
				accept:
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
				"accept-language": "en-US,en;q=0.9",
				"cache-control": "no-cache",
				pragma: "no-cache",
				"sec-fetch-dest": "document",
				"sec-fetch-mode": "navigate",
				"sec-fetch-site": "none",
				"sec-fetch-user": "?1",
				"upgrade-insecure-requests": "1",
				"user-agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
				cookie: cookieHeader,
			},
			redirect: "follow",
		});

		const html = await response.text();
		return { response, html };
	}

	private applyMergedCookieJar(
		cookieJar: YoutubeCookieJar,
		headers: Headers,
	): YoutubeCookieJar {
		const merged = this.mergeCookieJarFromResponseHeaders(cookieJar, headers);
		if (merged?.stats.blockedCriticalDeletionNames.length) {
			console.warn(
				`[youtube-cookie-jar] blocked_critical_deletions names=${merged.stats.blockedCriticalDeletionNames.join(",")}`,
			);
		}
		return merged ? merged.cookieJar : cookieJar;
	}

	private async warmupGuideRequests(input: {
		telegramUserId: number;
		cookieJar: YoutubeCookieJar;
		runtimeContext: RuntimeRequestContext;
	}): Promise<YoutubeCookieJar> {
		let cookieJar = input.cookieJar;

		for (
			let requestIndex = 0;
			requestIndex < GUIDE_WARMUP_REQUESTS;
			requestIndex += 1
		) {
			const authHeader = this.computeAuthorizationHeader(cookieJar);
			const response = await fetch(
				`${YOUTUBE_ORIGIN}/youtubei/v1/guide?prettyPrint=false&key=${encodeURIComponent(input.runtimeContext.apiKey)}`,
				{
					method: "POST",
					headers: {
						accept: "*/*",
						"accept-language": "en-US,en;q=0.9",
						"content-type": "application/json",
						origin: YOUTUBE_ORIGIN,
						referer: `${YOUTUBE_ORIGIN}/`,
						"user-agent":
							"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
						cookie: this.buildCookieHeader(cookieJar),
						authorization: authHeader,
						"x-origin": YOUTUBE_ORIGIN,
						"x-goog-authuser": input.runtimeContext.sessionIndex,
						...(input.runtimeContext.visitorData
							? { "x-goog-visitor-id": input.runtimeContext.visitorData }
							: {}),
						"x-youtube-client-name": input.runtimeContext.clientName,
						"x-youtube-client-version": input.runtimeContext.clientVersion,
					},
					body: JSON.stringify({
						context: {
							client: {
								clientName: "WEB",
								clientVersion: input.runtimeContext.clientVersion,
								hl: "en",
								gl: "US",
								...(input.runtimeContext.visitorData
									? { visitorData: input.runtimeContext.visitorData }
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
				},
			);
			console.log(
				`[youtube] user=${input.telegramUserId} guide_warmup index=${requestIndex + 1} status=${response.status} ok=${response.ok}`,
			);

			cookieJar = this.applyMergedCookieJar(cookieJar, response.headers);
		}

		return cookieJar;
	}

	private extractRuntimeRequestContext(html: string): RuntimeRequestContext {
		const apiKey =
			this.extractStringFromHtml(html, /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/) ??
			DEFAULT_INNERTUBE_API_KEY;
		const clientVersion =
			this.extractStringFromHtml(
				html,
				/"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([^"]+)"/,
			) ??
			this.extractStringFromHtml(
				html,
				/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/,
			) ??
			DEFAULT_CLIENT_VERSION;
		const clientName =
			this.extractStringFromHtml(
				html,
				/"INNERTUBE_CONTEXT_CLIENT_NAME"\s*:\s*"([^"]+)"/,
			) ?? DEFAULT_CLIENT_NAME;
		const sessionIndex =
			this.extractStringFromHtml(html, /"SESSION_INDEX"\s*:\s*"([^"]+)"/) ??
			"0";
		const visitorData =
			this.extractStringFromHtml(html, /"VISITOR_DATA"\s*:\s*"([^"]+)"/) ??
			null;

		return {
			apiKey,
			clientVersion,
			clientName,
			sessionIndex,
			visitorData,
		};
	}

	private extractStringFromHtml(html: string, pattern: RegExp): string | null {
		const match = html.match(pattern);
		const value = match?.[1];
		return value ? value : null;
	}

	private computeAuthorizationHeader(cookieJar: YoutubeCookieJar): string {
		const primary = cookieJar.SAPISID?.value ?? cookieJar.APISID?.value;
		if (!primary) {
			throw new Error(
				"Missing SAPISID/APISID cookie required for auth signing",
			);
		}

		const firstParty = cookieJar["__Secure-1PAPISID"]?.value ?? primary;
		const thirdParty = cookieJar["__Secure-3PAPISID"]?.value ?? primary;
		const timestamp = Math.floor(Date.now() / 1000);

		const makeToken = (name: string, secret: string): string => {
			const payload = `${timestamp} ${secret} ${YOUTUBE_ORIGIN}`;
			const digest = new Bun.CryptoHasher("sha1").update(payload).digest("hex");
			return `${name} ${timestamp}_${digest}_u`;
		};

		return [
			makeToken("SAPISIDHASH", primary),
			makeToken("SAPISID1PHASH", firstParty),
			makeToken("SAPISID3PHASH", thirdParty),
		].join(" ");
	}

	private logAuthOrConsentDiagnostics(input: {
		telegramUserId: number;
		response: Response;
		html: string;
	}) {
		const title = this.extractHtmlTitle(input.html);
		const hasSigninPrompt = /\bSign in\b/i.test(input.html);
		const hasServiceLogin = /ServiceLogin/i.test(input.html);
		const hasAccountsGoogleSignin = /accounts\.google\.com\/signin/i.test(
			input.html,
		);
		const hasConsentYoutube = /consent\.youtube\.com/i.test(input.html);
		const setCookieNames = this.extractSetCookieHeaders(input.response.headers)
			.map((setCookieHeader) => this.extractSetCookieName(setCookieHeader))
			.filter((name): name is string => Boolean(name));

		console.warn(
			`[youtube-auth-diagnostic] user=${input.telegramUserId} status=${input.response.status} url=${input.response.url || "-"} title=${title || "-"} has_signin=${hasSigninPrompt} has_service_login=${hasServiceLogin} has_accounts_google_signin=${hasAccountsGoogleSignin} has_consent_youtube=${hasConsentYoutube} set_cookie_names=${setCookieNames.join(",") || "-"}`,
		);
	}

	private logHistoryResponse(input: {
		telegramUserId: number;
		stage: string;
		response: Response;
		html: string;
	}) {
		console.log(
			`[youtube] user=${input.telegramUserId} stage=${input.stage} status=${input.response.status} ok=${input.response.ok} url=${input.response.url || "-"} title=${this.extractHtmlTitle(input.html) || "-"} has_auth_or_consent=${this.looksLikeAuthOrConsentPage(input.html)}`,
		);
	}

	private extractHtmlTitle(html: string): string | null {
		const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
		if (!match?.[1]) {
			return null;
		}

		return match[1].replace(/\s+/g, " ").trim();
	}

	private buildCookieHeader(cookieJar: YoutubeCookieJar): string {
		const nowMs = Date.now();
		const entries: string[] = [];

		for (const [cookieName, cookie] of Object.entries(cookieJar)) {
			if (!cookieName || !cookie.value) {
				continue;
			}

			if (cookie.expiresAt) {
				const expiryMs = Date.parse(cookie.expiresAt);
				if (Number.isFinite(expiryMs) && expiryMs <= nowMs) {
					continue;
				}
			}

			entries.push(`${cookieName}=${cookie.value}`);
		}

		if (entries.length === 0) {
			throw new Error("No valid YouTube cookies remain in cookie jar");
		}

		return entries.join("; ");
	}

	private mergeCookieJarFromResponseHeaders(
		currentCookieJar: YoutubeCookieJar,
		headers: Headers,
	): CookieJarMergeResult | null {
		const setCookieHeaders = this.extractSetCookieHeaders(headers);
		if (setCookieHeaders.length === 0) {
			return null;
		}

		const nextCookieJar: YoutubeCookieJar = { ...currentCookieJar };
		const nowMs = Date.now();
		const stats = {
			added: 0,
			updated: 0,
			deleted: 0,
			addedNames: [] as string[],
			updatedNames: [] as string[],
			deletedNames: [] as string[],
			blockedCriticalDeletionNames: [] as string[],
		};

		for (const setCookieHeader of setCookieHeaders) {
			const parsedCookie = this.parseSetCookie(setCookieHeader, nowMs);
			if (!parsedCookie) {
				continue;
			}

			if (parsedCookie.shouldDelete) {
				if (CRITICAL_AUTH_COOKIES.has(parsedCookie.name)) {
					stats.blockedCriticalDeletionNames.push(parsedCookie.name);
					continue;
				}

				if (parsedCookie.name in nextCookieJar) {
					delete nextCookieJar[parsedCookie.name];
					stats.deleted += 1;
					stats.deletedNames.push(parsedCookie.name);
				}
				continue;
			}

			const previousCookie = nextCookieJar[parsedCookie.name];
			nextCookieJar[parsedCookie.name] = parsedCookie.cookie;
			if (!previousCookie) {
				stats.added += 1;
				stats.addedNames.push(parsedCookie.name);
				continue;
			}

			if (
				JSON.stringify(previousCookie) !== JSON.stringify(parsedCookie.cookie)
			) {
				stats.updated += 1;
				stats.updatedNames.push(parsedCookie.name);
			}
		}

		if (
			JSON.stringify(nextCookieJar) === JSON.stringify(currentCookieJar) &&
			stats.blockedCriticalDeletionNames.length === 0
		) {
			return null;
		}

		return {
			cookieJar: nextCookieJar,
			stats,
		};
	}

	private extractSetCookieHeaders(headers: Headers): string[] {
		const getSetCookie = (
			headers as Headers & { getSetCookie?: () => string[] }
		).getSetCookie;
		if (typeof getSetCookie === "function") {
			const values = getSetCookie.call(headers);
			if (values.length > 0) {
				return values;
			}
		}

		const combinedHeaderValue = headers.get("set-cookie");
		if (!combinedHeaderValue) {
			return [];
		}

		return this.splitCombinedSetCookieHeader(combinedHeaderValue);
	}

	private splitCombinedSetCookieHeader(combinedHeaderValue: string): string[] {
		const cookies: string[] = [];
		let start = 0;
		let insideExpires = false;

		for (let index = 0; index < combinedHeaderValue.length; index += 1) {
			const char = combinedHeaderValue[index];
			if (!char) {
				continue;
			}

			const lowerSuffix = combinedHeaderValue
				.slice(Math.max(0, index - 8), index + 1)
				.toLowerCase();
			if (lowerSuffix.endsWith("expires=")) {
				insideExpires = true;
			}

			if (insideExpires && char === ";") {
				insideExpires = false;
			}

			if (char === "," && !insideExpires) {
				const part = combinedHeaderValue.slice(start, index).trim();
				if (part) {
					cookies.push(part);
				}
				start = index + 1;
			}
		}

		const trailingPart = combinedHeaderValue.slice(start).trim();
		if (trailingPart) {
			cookies.push(trailingPart);
		}

		return cookies;
	}

	private extractSetCookieName(setCookieHeader: string): string | null {
		const firstSection = setCookieHeader.split(";", 1)[0];
		if (!firstSection) {
			return null;
		}

		const separatorIndex = firstSection.indexOf("=");
		if (separatorIndex <= 0) {
			return null;
		}

		const cookieName = firstSection.slice(0, separatorIndex).trim();
		return cookieName || null;
	}

	private parseSetCookie(
		setCookieHeader: string,
		nowMs: number,
	): {
		name: string;
		cookie: YoutubeCookieJar[string];
		shouldDelete: boolean;
	} | null {
		const sections = setCookieHeader
			.split(";")
			.map((section) => section.trim())
			.filter((section) => section.length > 0);
		const [nameValue, ...attributes] = sections;
		if (!nameValue) {
			return null;
		}

		const separatorIndex = nameValue.indexOf("=");
		if (separatorIndex <= 0) {
			return null;
		}

		const name = nameValue.slice(0, separatorIndex).trim();
		const value = nameValue.slice(separatorIndex + 1);
		if (!name) {
			return null;
		}

		let expiresAt: string | null = null;
		let domain: string | null = null;
		let path: string | null = null;
		let secure = false;
		let httpOnly = false;
		let sameSite: string | null = null;
		let shouldDelete = value.length === 0;

		for (const attribute of attributes) {
			const attributeSeparatorIndex = attribute.indexOf("=");
			const attributeName = (
				attributeSeparatorIndex === -1
					? attribute
					: attribute.slice(0, attributeSeparatorIndex)
			)
				.trim()
				.toLowerCase();
			const attributeValue =
				attributeSeparatorIndex === -1
					? ""
					: attribute.slice(attributeSeparatorIndex + 1).trim();

			if (attributeName === "max-age") {
				const maxAgeSeconds = Number.parseInt(attributeValue, 10);
				if (Number.isFinite(maxAgeSeconds)) {
					if (maxAgeSeconds <= 0) {
						shouldDelete = true;
					} else {
						expiresAt = new Date(nowMs + maxAgeSeconds * 1_000).toISOString();
					}
				}
				continue;
			}

			if (attributeName === "expires") {
				const expiresMs = Date.parse(attributeValue);
				if (Number.isFinite(expiresMs)) {
					if (expiresMs <= nowMs) {
						shouldDelete = true;
					} else {
						expiresAt = new Date(expiresMs).toISOString();
					}
				}
				continue;
			}

			if (attributeName === "domain") {
				domain = attributeValue || null;
				continue;
			}

			if (attributeName === "path") {
				path = attributeValue || null;
				continue;
			}

			if (attributeName === "secure") {
				secure = true;
				continue;
			}

			if (attributeName === "httponly") {
				httpOnly = true;
				continue;
			}

			if (attributeName === "samesite") {
				sameSite = attributeValue || null;
			}
		}

		return {
			name,
			cookie: {
				value,
				expiresAt,
				domain,
				path,
				secure,
				httpOnly,
				sameSite,
			},
			shouldDelete,
		};
	}

	private extractYtInitialData(html: string): unknown {
		const patterns = [
			/var ytInitialData = (\{[\s\S]*?\});<\/script>/,
			/ytInitialData\s*=\s*(\{[\s\S]*?\});/,
		];

		for (const pattern of patterns) {
			const match = html.match(pattern);
			if (!match?.[1]) {
				continue;
			}
			try {
				return JSON.parse(match[1]);
			} catch {}
		}

		throw new Error("Could not locate ytInitialData in history HTML");
	}

	private extractVideosFromHistoryData(data: unknown): YoutubeVideo[] {
		const stack: unknown[] = [data];
		const videos: YoutubeVideo[] = [];
		const seenVideoIds = new Set<string>();

		while (stack.length > 0) {
			const current = stack.pop();
			if (!current || typeof current !== "object") {
				continue;
			}

			const maybeRenderer = current as { videoRenderer?: unknown };
			if (
				maybeRenderer.videoRenderer &&
				typeof maybeRenderer.videoRenderer === "object"
			) {
				const video = maybeRenderer.videoRenderer as {
					videoId?: unknown;
					title?: { runs?: Array<{ text?: unknown }> };
					ownerText?: { runs?: Array<{ text?: unknown }> };
					publishedTimeText?: {
						simpleText?: unknown;
						runs?: Array<{ text?: unknown }>;
					};
					lengthText?: { simpleText?: unknown };
					thumbnailOverlays?: Array<{
						thumbnailOverlayResumePlaybackRenderer?: {
							percentDurationWatched?: unknown;
						};
					}>;
				};

				const videoId =
					typeof video.videoId === "string" ? video.videoId : null;
				const title =
					typeof video.title?.runs?.[0]?.text === "string"
						? video.title.runs[0].text
						: null;
				const channelTitle =
					typeof video.ownerText?.runs?.[0]?.text === "string"
						? video.ownerText.runs[0].text
						: "Unknown channel";
				const lengthText =
					typeof video.lengthText?.simpleText === "string"
						? video.lengthText.simpleText
						: null;
				const durationSeconds = this.parseClockDurationToSeconds(lengthText);
				const watchedRatio = this.percentToRatio(
					video.thumbnailOverlays?.find((overlay) =>
						Boolean(overlay.thumbnailOverlayResumePlaybackRenderer),
					)?.thumbnailOverlayResumePlaybackRenderer?.percentDurationWatched,
				);

				if (
					videoId &&
					title &&
					!seenVideoIds.has(videoId) &&
					durationSeconds >= MIN_VIDEO_LENGTH_SECONDS
				) {
					seenVideoIds.add(videoId);
					const publishedText =
						typeof video.publishedTimeText?.simpleText === "string"
							? video.publishedTimeText.simpleText
							: typeof video.publishedTimeText?.runs?.[0]?.text === "string"
								? video.publishedTimeText.runs[0].text
								: "just now";

					videos.push({
						id: videoId,
						title,
						channelTitle,
						publishedAt: this.parseRelativeTimeToIso(publishedText),
						watchedRatio,
					});
				}
			}

			const maybeLockup = current as { lockupViewModel?: unknown };
			if (
				maybeLockup.lockupViewModel &&
				typeof maybeLockup.lockupViewModel === "object"
			) {
				const lockup = maybeLockup.lockupViewModel as {
					contentId?: unknown;
					contentType?: unknown;
					contentImage?: {
						thumbnailViewModel?: {
							overlays?: Array<{
								thumbnailBottomOverlayViewModel?: {
									progressBar?: {
										thumbnailOverlayProgressBarViewModel?: {
											startPercent?: unknown;
										};
									};
									badges?: Array<{
										thumbnailBadgeViewModel?: {
											text?: unknown;
										};
									}>;
								};
							}>;
						};
					};
					metadata?: {
						lockupMetadataViewModel?: {
							title?: { content?: unknown };
							metadata?: {
								contentMetadataViewModel?: {
									metadataRows?: Array<{
										metadataParts?: Array<{ text?: { content?: unknown } }>;
									}>;
								};
							};
						};
					};
					rendererContext?: {
						accessibilityContext?: {
							label?: unknown;
						};
					};
				};

				const contentType =
					typeof lockup.contentType === "string" ? lockup.contentType : null;
				const videoId =
					typeof lockup.contentId === "string" ? lockup.contentId : null;
				const title =
					typeof lockup.metadata?.lockupMetadataViewModel?.title?.content ===
					"string"
						? lockup.metadata.lockupMetadataViewModel.title.content
						: null;
				const badgeText =
					typeof lockup.contentImage?.thumbnailViewModel?.overlays?.[0]
						?.thumbnailBottomOverlayViewModel?.badges?.[0]
						?.thumbnailBadgeViewModel?.text === "string"
						? lockup.contentImage.thumbnailViewModel.overlays?.[0]
								?.thumbnailBottomOverlayViewModel?.badges?.[0]
								?.thumbnailBadgeViewModel?.text
						: null;
				const durationSeconds = this.parseClockDurationToSeconds(badgeText);
				const watchedRatio = this.percentToRatio(
					lockup.contentImage?.thumbnailViewModel?.overlays?.[0]
						?.thumbnailBottomOverlayViewModel?.progressBar
						?.thumbnailOverlayProgressBarViewModel?.startPercent,
				);

				const firstRow =
					lockup.metadata?.lockupMetadataViewModel?.metadata
						?.contentMetadataViewModel?.metadataRows?.[0];
				const channelTitle =
					typeof firstRow?.metadataParts?.[0]?.text?.content === "string"
						? firstRow.metadataParts[0].text.content
						: "Unknown channel";

				if (
					contentType === "LOCKUP_CONTENT_TYPE_VIDEO" &&
					videoId &&
					title &&
					!seenVideoIds.has(videoId) &&
					durationSeconds >= MIN_VIDEO_LENGTH_SECONDS
				) {
					seenVideoIds.add(videoId);
					videos.push({
						id: videoId,
						title,
						channelTitle,
						publishedAt: new Date().toISOString(),
						watchedRatio,
					});
				}
			}

			for (const value of Object.values(current)) {
				stack.push(value);
			}
		}

		return videos.sort(
			(a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
		);
	}

	private parseClockDurationToSeconds(value: string | null): number {
		if (!value) {
			return 0;
		}

		const parts = value
			.split(":")
			.map((part) => Number.parseInt(part.trim(), 10));

		if (parts.some((part) => Number.isNaN(part))) {
			return 0;
		}

		if (parts.length === 2) {
			const [minutes = 0, seconds = 0] = parts;
			return minutes * 60 + seconds;
		}

		if (parts.length === 3) {
			const [hours = 0, minutes = 0, seconds = 0] = parts;
			return hours * 3600 + minutes * 60 + seconds;
		}

		return 0;
	}

	private parseRelativeTimeToIso(value: string): string {
		const normalized = value.toLowerCase();
		const now = Date.now();

		const match = normalized.match(
			/(\d+)\s+(second|minute|hour|day|week|month|year)s?/,
		);
		if (!match) {
			if (normalized.includes("yesterday")) {
				return new Date(now - 24 * 60 * 60 * 1000).toISOString();
			}
			return new Date(now).toISOString();
		}

		const [, amountText, unitText] = match;
		const amount = Number.parseInt(amountText ?? "0", 10);
		const unit = unitText ?? "second";
		const factorMs: Record<string, number> = {
			second: 1_000,
			minute: 60_000,
			hour: 3_600_000,
			day: 86_400_000,
			week: 604_800_000,
			month: 2_592_000_000,
			year: 31_536_000_000,
		};

		return new Date(now - amount * (factorMs[unit] ?? 0)).toISOString();
	}

	private looksLikeAuthOrConsentPage(html: string): boolean {
		const hasSigninPrompt = /\bSign in\b/i.test(html);
		const hasAuthFlowMarker =
			/ServiceLogin|accounts\.google\.com\/signin|consent\.youtube\.com/i.test(
				html,
			);
		return hasSigninPrompt && hasAuthFlowMarker;
	}

	private percentToRatio(percent: unknown): number {
		if (typeof percent !== "number" || Number.isNaN(percent)) {
			return 0;
		}
		return Math.max(0, Math.min(100, percent)) / 100;
	}
}
