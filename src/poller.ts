import type { Api } from "grammy";
import type { QuizBot } from "./bot";
import { config } from "./config";
import type { AppDatabase } from "./db";
import type { GeminiService } from "./gemini";
import type { YoutubeService } from "./youtube";

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

		setTimeout(() => {
			this.pollOnce().catch((error) => {
				console.error("Scheduled poll failed", error);
			});

			setInterval(() => {
				this.pollOnce().catch((error) => {
					console.error("Poll failed", error);
				});
			}, intervalMs);
		}, initialDelayMs);
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
		const linkedUsers = this.db.getLinkedUsers().filter((user) => {
			if (config.TELEGRAM_USER_ID_WHITELIST.length === 0) {
				return true;
			}
			return config.TELEGRAM_USER_ID_WHITELIST.includes(user.telegramUserId);
		});

		for (const user of linkedUsers) {
			try {
				let activeQuizCount = this.db.countActiveQuizSessions(
					user.telegramUserId,
				);
				if (activeQuizCount >= 3) {
					continue;
				}
				const slotsAvailable = 3 - activeQuizCount;

				const videos = await this.youtubeService.listRecentWatchedVideos(
					user,
					config.QUIZ_MAX_HISTORY_ITEMS,
					config.MIN_WATCH_RATIO,
				);

				const unseen = videos
					.filter(
						(video) => !this.db.hasQuizForVideo(user.telegramUserId, video.id),
					)
					.sort((a, b) => (a.publishedAt > b.publishedAt ? -1 : 1));

				const selected = unseen.slice(0, slotsAvailable);
				let newestProcessedPublishedAt: string | null = null;

				for (const video of selected) {
					const quiz = await this.geminiService.generateQuiz({
						videoId: video.id,
						videoTitle: video.title,
						channelTitle: video.channelTitle,
					});

					this.db.createQuizSession(user.telegramUserId, user.chatId, quiz);
					await this.quizBot.sendQuizIntro({
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
				}

				if (newestProcessedPublishedAt) {
					this.db.markVideoPolled(
						user.telegramUserId,
						newestProcessedPublishedAt,
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const relinkHint = message.toLowerCase().includes("run /link")
					? "\n\nPlease relink now: send /link and paste a fresh Cookie header."
					: "";
				await this.telegramApi.sendMessage(
					user.chatId,
					`Polling failed for your account: ${message}.${relinkHint}`,
				);
			}
		}
	}
}
