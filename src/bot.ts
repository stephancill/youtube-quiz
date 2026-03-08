import { Bot, type Context } from "grammy";
import { config } from "./config";
import type { AppDatabase } from "./db";
import type { GeminiService } from "./gemini";

export class QuizBot {
	private bot: Bot;
	private awaitingCookieInput = new Set<number>();

	constructor(
		private db: AppDatabase,
		private geminiService: GeminiService,
	) {
		this.bot = new Bot(config.TELEGRAM_BOT_TOKEN);
		this.registerHandlers();
	}

	async start() {
		await this.bot.start();
	}

	getTelegramApi() {
		return this.bot.api;
	}

	private registerHandlers() {
		this.bot.catch((error) => {
			console.error("Telegram bot error", error.error);
		});

		this.bot.command("start", async (ctx) => {
			if (!ctx.from) {
				return;
			}
			const chatId = ctx.chatId;
			if (chatId === undefined) {
				return;
			}

			this.db.upsertTelegramUser(ctx.from.id, chatId);
			await ctx.reply(
				"Welcome. Use /link to connect YouTube, then I will periodically send 3-question quizzes from your watch history.",
			);
		});

		this.bot.command("link", async (ctx) => {
			if (!ctx.from) {
				return;
			}
			const chatId = ctx.chatId;
			if (chatId === undefined) {
				return;
			}

			this.db.upsertTelegramUser(ctx.from.id, chatId);
			this.awaitingCookieInput.add(ctx.from.id);
			await ctx.reply(
				"Paste your full YouTube Cookie header string in the next message (example: SID=...; HSID=...; SAPISID=...).",
			);
		});

		this.bot.command("status", async (ctx) => {
			if (!ctx.from) {
				return;
			}

			const active = this.db.getActiveQuizSession(ctx.from.id);
			if (!active) {
				await ctx.reply(
					"No active quiz. I will message you when a new eligible watched video appears.",
				);
				return;
			}

			await ctx.reply(
				`Active quiz for: ${active.videoTitle}\nQuestion ${active.currentQuestionIndex + 1} of ${active.questions.length}\nScore: ${active.score}`,
			);
		});

		this.bot.on("message:text", async (ctx) => {
			if (this.awaitingCookieInput.has(ctx.from?.id ?? -1)) {
				await this.handleCookieLinkMessage(ctx);
				return;
			}
			await this.handleQuizAnswer(ctx);
		});
	}

	private async handleCookieLinkMessage(ctx: Context) {
		if (!ctx.from) {
			return;
		}

		const message = ctx.message;
		if (!message || !("text" in message) || !message.text) {
			return;
		}

		try {
			const cookieHeader = this.validateCookieHeader(message.text);
			this.db.saveYoutubeCookieHeader(ctx.from.id, cookieHeader);
			this.awaitingCookieInput.delete(ctx.from.id);
			await ctx.reply(
				"Cookie header saved. I will now poll your history feed and generate quizzes.",
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Invalid cookie header";
			await ctx.reply(
				`Could not parse cookie header: ${message}. Paste a semicolon-separated header string like SID=...; HSID=...; SAPISID=...`,
			);
		}
	}

	private validateCookieHeader(input: string): string {
		const normalized = input.trim();
		if (!normalized) {
			throw new Error("empty string");
		}

		const pairs = normalized
			.split(";")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);

		if (pairs.length === 0 || pairs.every((pair) => !pair.includes("="))) {
			throw new Error("missing key=value pairs");
		}

		return pairs.join("; ");
	}

	async sendQuizIntro(input: {
		telegramUserId: number;
		chatId: number;
		videoId: string;
		videoTitle: string;
	}) {
		const videoUrl = `https://www.youtube.com/watch?v=${input.videoId}`;
		await this.bot.api.sendMessage(
			input.chatId,
			`New quiz unlocked from your watch history:\n<a href="${videoUrl}">${input.videoTitle}</a>`,
			{ parse_mode: "HTML" },
		);
		await this.sendCurrentQuestion(input.telegramUserId, input.chatId);
	}

	async sendCurrentQuestion(telegramUserId: number, chatId: number) {
		const active = this.db.getActiveQuizSession(telegramUserId);
		if (!active) {
			return;
		}

		const question = active.questions[active.currentQuestionIndex];
		if (!question) {
			return;
		}

		await this.bot.api.sendMessage(
			chatId,
			`Question ${active.currentQuestionIndex + 1}/${active.questions.length}\n${question.prompt}\n\nHint: relevant moment around ${question.sourceTimestamp}.\nReply with a short free-form answer.`,
		);
	}

	private async handleQuizAnswer(ctx: Context) {
		if (!ctx.from) {
			return;
		}

		const message = ctx.message;
		if (!message || !("text" in message)) {
			return;
		}

		const active = this.db.getActiveQuizSession(ctx.from.id);
		if (!active) {
			return;
		}

		const question = active.questions[active.currentQuestionIndex];
		if (!question) {
			return;
		}

		const text = message.text;
		if (!text) {
			return;
		}

		const userAnswer = text.trim();

		const grade = await this.geminiService.gradeAnswer({
			question: question.prompt,
			correctAnswer: question.correctAnswer,
			sourceTimestamp: question.sourceTimestamp,
			userAnswer,
		});

		const nextScore = grade.isCorrect ? active.score + 1 : active.score;
		const nextIndex = active.currentQuestionIndex + 1;
		this.db.advanceQuizSession(active.id, nextIndex, nextScore);

		await ctx.reply(
			`${grade.isCorrect ? "Correct" : "Not quite"}. ${grade.feedback}`,
		);

		if (nextIndex >= active.questions.length) {
			this.db.completeQuizSession(active.id);
			await ctx.reply(
				`Quiz complete. Final score: ${nextScore}/${active.questions.length}`,
			);
			return;
		}

		await this.sendCurrentQuestion(ctx.from.id, ctx.chat?.id ?? active.chatId);
	}
}
