import type { Api } from "grammy";
import type { QuizBot } from "./bot";
import { config } from "./config";
import type { AppDatabase } from "./db";
import type { GeminiService } from "./gemini";
import type { YoutubeService } from "./youtube";

const POLL_JITTER_FACTOR = 0.15;
const AUTH_RETRY_MIN_DELAY_MS = 5_000;
const AUTH_RETRY_MAX_DELAY_MS = 10_000;

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
    const initialDelayMs = this.getDelayUntilNextBoundary(new Date(), config.POLL_INTERVAL_MINUTES);
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
    telegramUserId: number;
    chatId: number;
    youtubeUser: Parameters<YoutubeService["listRecentWatchedVideos"]>[0];
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
        Math.floor(Math.random() * (AUTH_RETRY_MAX_DELAY_MS - AUTH_RETRY_MIN_DELAY_MS + 1)) +
        AUTH_RETRY_MIN_DELAY_MS;

      console.warn(
        `[poller] user=${input.telegramUserId} auth_failure_retry_in_ms=${retryDelayMs}`,
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

  private getDelayUntilNextBoundary(now: Date, intervalMinutes: number): number {
    const minutesSinceMidnight = now.getHours() * 60 + now.getMinutes();
    const nextBoundaryMinutes =
      Math.floor(minutesSinceMidnight / intervalMinutes) * intervalMinutes + intervalMinutes;

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
    console.log(`[poller] run_start linked_users=${linkedUsers.length}`);

    for (const user of linkedUsers) {
      try {
        let activeQuizCount = this.db.countActiveQuizSessions(user.telegramUserId);
        console.log(
          `[poller] user=${user.telegramUserId} active_quizzes=${activeQuizCount} last_polled=${user.lastPolledPublishedAt ?? "-"}`,
        );
        if (activeQuizCount >= 3) {
          console.log(`[poller] user=${user.telegramUserId} skipped=active_quiz_limit`);
          continue;
        }
        const slotsAvailable = 3 - activeQuizCount;

        const videos = await this.listRecentWatchedVideosWithRetry({
          telegramUserId: user.telegramUserId,
          chatId: user.chatId,
          youtubeUser: user,
        });
        console.log(
          `[poller] user=${user.telegramUserId} youtube_videos=${videos.length} slots_available=${slotsAvailable}`,
        );

        const unseen = videos
          .filter((video) => !this.db.hasQuizForVideo(user.telegramUserId, video.id))
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
          if (!newestProcessedPublishedAt || video.publishedAt > newestProcessedPublishedAt) {
            newestProcessedPublishedAt = video.publishedAt;
          }
          activeQuizCount += 1;
        }

        if (newestProcessedPublishedAt) {
          this.db.markVideoPolled(user.telegramUserId, newestProcessedPublishedAt);
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
    console.log(`[poller] run_complete elapsed_ms=${Date.now() - startedAt}`);
  }
}
