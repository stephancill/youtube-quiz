import type { LinkedUser, YoutubeVideo } from "./types";

const MIN_VIDEO_LENGTH_SECONDS = 5 * 60;

export class YoutubeService {
	async listRecentWatchedVideos(
		user: LinkedUser,
		maxResults: number,
		minWatchRatio: number,
	): Promise<YoutubeVideo[]> {
		const cookieHeader = this.validateCookieHeader(user.youtubeCookieHeader);

		const response = await fetch("https://www.youtube.com/feed/history", {
			headers: {
				"user-agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
				cookie: cookieHeader,
			},
			redirect: "follow",
		});

		if (!response.ok) {
			throw new Error(`YouTube history request failed with ${response.status}`);
		}

		const html = await response.text();
		const ytInitialData = this.extractYtInitialData(html);
		const videos = this.extractVideosFromHistoryData(ytInitialData)
			.filter((video) => video.watchedRatio >= minWatchRatio)
			.slice(0, maxResults);

		if (videos.length === 0 && this.looksLikeAuthOrConsentPage(html)) {
			throw new Error(
				"YouTube cookies appear expired or invalid. Please run /link and paste a fresh Cookie header.",
			);
		}

		return videos;
	}

	private validateCookieHeader(header: string): string {
		const normalized = header.trim();
		if (!normalized) {
			throw new Error("Cookie header is empty");
		}
		if (!normalized.includes("=")) {
			throw new Error("Cookie header does not include key=value pairs");
		}
		return normalized;
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
