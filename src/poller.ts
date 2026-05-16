import type { Api } from "grammy";
import { sendApnsNotification } from "./apns";
import type { QuizBot } from "./bot";
import { config } from "./config";
import type { AppDatabase } from "./db";
import type { GeminiService } from "./gemini";
import type { AppLinkedUser, LinkedUser } from "./types";
import type { YoutubeService } from "./youtube";

const POLL_JITTER_FACTOR = 0.15;
const AUTH_RETRY_MIN_DELAY_MS = 5_000;
const AUTH_RETRY_MAX_DELAY_MS = 10_000;
const MAX_ACTIVE_QUIZ_SESSIONS = 10;

export class WatchHistoryPoller {
	constructor(
		private db: AppDatabase,
		private youtubeService: YoutubeService,
		private geminiService: GeminiService,
		private quizBot: QuizBot,
		private telegramApi: Api,
	) {}

	start() {
		const intervalMs = config.POLL_INTERVAL_MINUTES * 60 * 1000;
		const initialDelayMs = this.getDelayUntilNextBoundary(
			new Date(),
			config.POLL_INTERVAL_MINUTES,
		);
		console.log(
			`[poller] started interval_minutes=${config.POLL_INTERVAL_MINUTES} initial_delay_ms=${initialDelayMs}`,
		);

		const runAndScheduleNext = () => {
			this.pollOnce()
				.catch((error) => {
					console.error("Poll failed", error);
				})
				.finally(() => {
					const jitteredDelayMs = this.applyJitter(intervalMs);
					console.log(`[poller] next_run_in_ms=${jitteredDelayMs}`);
					setTimeout(runAndScheduleNext, jitteredDelayMs);
				});
		};

		setTimeout(() => {
			runAndScheduleNext();
		}, initialDelayMs);
	}

	private applyJitter(baseDelayMs: number): number {
		const jitterRatio = (Math.random() * 2 - 1) * POLL_JITTER_FACTOR;
		const jitteredDelayMs = Math.round(baseDelayMs * (1 + jitterRatio));
		return Math.max(1_000, jitteredDelayMs);
	}

	private async listRecentWatchedVideosWithRetry(input: {
		logUserId: string;
		youtubeUser: LinkedUser;
	}): Promise<Awaited<ReturnType<YoutubeService["listRecentWatchedVideos"]>>> {
		try {
			return await this.youtubeService.listRecentWatchedVideos(
				input.youtubeUser,
				config.QUIZ_MAX_HISTORY_ITEMS,
				config.MIN_WATCH_RATIO,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const isAuthFailure = message
				.toLowerCase()
				.includes("youtube cookies appear expired or invalid");

			if (!isAuthFailure) {
				throw error;
			}

			const retryDelayMs =
				Math.floor(
					Math.random() *
						(AUTH_RETRY_MAX_DELAY_MS - AUTH_RETRY_MIN_DELAY_MS + 1),
				) + AUTH_RETRY_MIN_DELAY_MS;

			console.warn(
				`[poller] user=${input.logUserId} auth_failure_retry_in_ms=${retryDelayMs}`,
			);
			await this.sleep(retryDelayMs);

			return this.youtubeService.listRecentWatchedVideos(
				input.youtubeUser,
				config.QUIZ_MAX_HISTORY_ITEMS,
				config.MIN_WATCH_RATIO,
			);
		}
	}

	private sleep(delayMs: number): Promise<void> {
		return new Promise((resolve) => {
			setTimeout(resolve, delayMs);
		});
	}

	private getDelayUntilNextBoundary(
		now: Date,
		intervalMinutes: number,
	): number {
		const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();
		const nextBoundaryMinutes =
			Math.floor(minutesSinceMidnight / intervalMinutes) * intervalMinutes +
			intervalMinutes;

		const nextBoundary = new Date(now);
		nextBoundary.setSeconds(0, 0);
		nextBoundary.setHours(0, 0, 0, 0);
		nextBoundary.setMinutes(nextBoundaryMinutes);

		if (nextBoundary <= now) {
			nextBoundary.setMinutes(nextBoundary.getMinutes() + intervalMinutes);
		}

		return nextBoundary.getTime() - now.getTime();
	}

	async pollOnce() {
		const startedAt = Date.now();
		const linkedUsers = this.db.getLinkedUsers().filter((user) => {
			if (config.TELEGRAM_USER_ID_WHITELIST.length === 0) {
				return true;
			}
			return config.TELEGRAM_USER_ID_WHITELIST.includes(user.telegramUserId);
		});
		const linkedAppUsers = this.db.getLinkedAppUsers();
		console.log(
			`[poller] run_start linked_users=${linkedUsers.length} linked_app_users=${linkedAppUsers.length}`,
		);

		for (const user of linkedUsers) {
			try {
				let activeQuizCount = this.db.countActiveQuizSessions(
					user.telegramUserId,
				);
				console.log(
					`[poller] user=${user.telegramUserId} active_quizzes=${activeQuizCount} last_polled=${user.lastPolledPublishedAt ?? "-"}`,
				);
				if (activeQuizCount >= MAX_ACTIVE_QUIZ_SESSIONS) {
					console.log(
						`[poller] user=${user.telegramUserId} skipped=active_quiz_limit`,
					);
					continue;
				}
				const slotsAvailable = MAX_ACTIVE_QUIZ_SESSIONS - activeQuizCount;

				const videos = await this.listRecentWatchedVideosWithRetry({
					logUserId: String(user.telegramUserId),
					youtubeUser: user,
				});
				console.log(
					`[poller] user=${user.telegramUserId} youtube_videos=${videos.length} slots_available=${slotsAvailable}`,
				);

				const unseen = videos
					.filter((video) => {
						if (this.db.hasQuizForVideo(user.telegramUserId, video.id)) {
							return false;
						}
						return (
							!user.lastPolledPublishedAt ||
							video.publishedAt > user.lastPolledPublishedAt
						);
					})
					.sort((a, b) => (a.publishedAt > b.publishedAt ? -1 : 1));

				const selected = unseen.slice(0, slotsAvailable);
				console.log(
					`[poller] user=${user.telegramUserId} unseen_videos=${unseen.length} selected_videos=${selected.length}`,
				);
				let newestProcessedPublishedAt: string | null = null;

				for (const video of selected) {
					console.log(
						`[poller] user=${user.telegramUserId} generating_quiz video_id=${video.id} published_at=${video.publishedAt}`,
					);
					try {
						const quiz = await this.geminiService.generateQuiz({
							videoId: video.id,
							videoTitle: video.title,
							channelTitle: video.channelTitle,
						});

						const quizId = this.db.createQuizSession(
							user.telegramUserId,
							user.chatId,
							quiz,
						);
						await this.quizBot.sendQuizIntro({
							quizId,
							telegramUserId: user.telegramUserId,
							chatId: user.chatId,
							videoId: video.id,
							videoTitle: video.title,
						});
						if (
							!newestProcessedPublishedAt ||
							video.publishedAt > newestProcessedPublishedAt
						) {
							newestProcessedPublishedAt = video.publishedAt;
						}
						activeQuizCount += 1;
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						console.error(
							`[poller] user=${user.telegramUserId} skip_video=${video.id} reason=${message}`,
						);
					}
				}

				if (newestProcessedPublishedAt) {
					this.db.markVideoPolled(
						user.telegramUserId,
						newestProcessedPublishedAt,
					);
					console.log(
						`[poller] user=${user.telegramUserId} marked_polled=${newestProcessedPublishedAt}`,
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[poller] user=${user.telegramUserId} failed=${message}`);
				const relinkHint = message.toLowerCase().includes("run /link")
					? "\n\nPlease relink now: send /link and paste a fresh Cookie header."
					: "";
				await this.telegramApi.sendMessage(
					user.chatId,
					`Polling failed for your account: ${message}.${relinkHint}`,
				);
			}
		}

		for (const user of linkedAppUsers) {
			await this.pollAppUser(user);
		}
		console.log(`[poller] run_complete elapsed_ms=${Date.now() - startedAt}`);
	}

	private async pollAppUser(user: AppLinkedUser) {
		try {
			let activeQuizCount = this.db.countActiveAppQuizSessions(user.appUserId);
			console.log(
				`[poller] app_user=${user.appUserId} active_quizzes=${activeQuizCount} last_polled=${user.lastPolledPublishedAt ?? "-"}`,
			);
			if (activeQuizCount >= MAX_ACTIVE_QUIZ_SESSIONS) {
				console.log(
					`[poller] app_user=${user.appUserId} skipped=active_quiz_limit`,
				);
				return;
			}

			const slotsAvailable = MAX_ACTIVE_QUIZ_SESSIONS - activeQuizCount;
			const youtubeUser: LinkedUser = {
				telegramUserId: -user.appUserId,
				chatId: 0,
				youtubeCookieJar: user.youtubeCookieJar,
				lastPolledPublishedAt: user.lastPolledPublishedAt,
			};
			const videos = await this.listRecentWatchedVideosWithRetry({
				logUserId: `app:${user.appUserId}`,
				youtubeUser,
			});
			console.log(
				`[poller] app_user=${user.appUserId} youtube_videos=${videos.length} slots_available=${slotsAvailable}`,
			);
			if (!user.lastPolledPublishedAt) {
				const newestSeenPublishedAt = videos.reduce<string | null>(
					(newest, video) =>
						!newest || video.publishedAt > newest ? video.publishedAt : newest,
					null,
				);
				if (newestSeenPublishedAt) {
					this.db.markAppVideoPolled(user.appUserId, newestSeenPublishedAt);
					console.log(
						`[poller] app_user=${user.appUserId} initialized_poll_baseline=${newestSeenPublishedAt}`,
					);
				}
				return;
			}

			const unseen = videos
				.filter((video) => {
					if (this.db.hasAppQuizForVideo(user.appUserId, video.id)) {
						return false;
					}
					return (
						!user.lastPolledPublishedAt ||
						video.publishedAt > user.lastPolledPublishedAt
					);
				})
				.sort((a, b) => (a.publishedAt > b.publishedAt ? -1 : 1));

			const selected = unseen.slice(0, slotsAvailable);
			console.log(
				`[poller] app_user=${user.appUserId} unseen_videos=${unseen.length} selected_videos=${selected.length}`,
			);
			let newestProcessedPublishedAt: string | null = null;

			for (const video of selected) {
				console.log(
					`[poller] app_user=${user.appUserId} generating_quiz video_id=${video.id} published_at=${video.publishedAt}`,
				);
				try {
					const quiz = await this.geminiService.generateQuiz({
						videoId: video.id,
						videoTitle: video.title,
						channelTitle: video.channelTitle,
					});
					this.db.createAppQuizSession(user.appUserId, quiz);
					await this.notifyAppUser({
						appUserId: user.appUserId,
						videoTitle: video.title,
					});
					if (
						!newestProcessedPublishedAt ||
						video.publishedAt > newestProcessedPublishedAt
					) {
						newestProcessedPublishedAt = video.publishedAt;
					}
					activeQuizCount += 1;
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(
						`[poller] app_user=${user.appUserId} skip_video=${video.id} reason=${message}`,
					);
				}
			}

			if (newestProcessedPublishedAt) {
				this.db.markAppVideoPolled(user.appUserId, newestProcessedPublishedAt);
				console.log(
					`[poller] app_user=${user.appUserId} marked_polled=${newestProcessedPublishedAt}`,
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[poller] app_user=${user.appUserId} failed=${message}`);
		}
	}

	private async notifyAppUser(input: {
		appUserId: number;
		videoTitle: string;
	}) {
		const deviceTokens = this.db.listNotificationDeviceTokens(input.appUserId);
		if (deviceTokens.length === 0) {
			return;
		}

		await Promise.allSettled(
			deviceTokens.map((deviceToken) =>
				sendApnsNotification({
					deviceToken,
					payload: {
						title: "New YouTube Quiz",
						body: input.videoTitle,
					},
				}),
			),
		);
	}
}
