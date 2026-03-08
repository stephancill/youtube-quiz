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
		this.pollOnce().catch((error) => {
			console.error("Initial poll failed", error);
		});

		const intervalMs = config.POLL_INTERVAL_MINUTES * 60 * 1000;
		setInterval(() => {
			this.pollOnce().catch((error) => {
				console.error("Poll failed", error);
			});
		}, intervalMs);
	}

	async pollOnce() {
		const linkedUsers = this.db.getLinkedUsers();

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
					.filter((video) => {
						if (this.db.hasQuizForVideo(user.telegramUserId, video.id)) {
							return false;
						}
						if (!user.lastPolledPublishedAt) {
							return true;
						}
						return video.publishedAt > user.lastPolledPublishedAt;
					})
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
