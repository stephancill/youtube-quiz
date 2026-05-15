import { QuizBot } from "./src/bot";
import { config } from "./src/config";
import { AppDatabase } from "./src/db";
import { GeminiService } from "./src/gemini";
import { WatchHistoryPoller } from "./src/poller";
import { createApiServer } from "./src/server";
import { YoutubeService } from "./src/youtube";

const db = new AppDatabase(config.DATABASE_PATH);

const youtubeService = new YoutubeService(db);

const geminiService = new GeminiService(config.GEMINI_API_KEY);
const quizBot = new QuizBot(db, geminiService, youtubeService);

const poller = new WatchHistoryPoller(
	db,
	youtubeService,
	geminiService,
	quizBot,
	quizBot.getTelegramApi(),
);

quizBot.setRefreshHistoryHandler(async () => {
	await poller.pollOnce();
});

const port = Number.parseInt(process.env.PORT ?? "", 10);

if (Number.isFinite(port) && port > 0) {
	createApiServer({ db, youtubeService }).listen(port, () => {
		console.log(`API server listening on :${port}`);
	});
}

poller.start();
await quizBot.start();
console.log(
	"Telegram bot started. Use /link to submit a YouTube Cookie header string.",
);
