import { createServer } from "node:http";
import { QuizBot } from "./src/bot";
import { config } from "./src/config";
import { AppDatabase } from "./src/db";
import { GeminiService } from "./src/gemini";
import { WatchHistoryPoller } from "./src/poller";
import { YoutubeService } from "./src/youtube";

const db = new AppDatabase(config.DATABASE_PATH);

const youtubeService = new YoutubeService();

const geminiService = new GeminiService(config.GEMINI_API_KEY);
const quizBot = new QuizBot(db, geminiService);

const poller = new WatchHistoryPoller(
	db,
	youtubeService,
	geminiService,
	quizBot,
	quizBot.getTelegramApi(),
);

const port = Number.parseInt(process.env.PORT ?? "", 10);

if (Number.isFinite(port) && port > 0) {
	createServer((_, res) => {
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		res.end("ok");
	}).listen(port, () => {
		console.log(`Health server listening on :${port}`);
	});
}

poller.start();
await quizBot.start();
console.log("Telegram bot started. Use /link to submit YouTube cookie JSON.");
