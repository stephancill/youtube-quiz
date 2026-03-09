import { Bot, type Context, InlineKeyboard } from "grammy";
import { config } from "./config";
import type { AppDatabase } from "./db";
import type { GeminiService } from "./gemini";

export class QuizBot {
	private bot: Bot;
	private awaitingCookieInput = new Set<number>();
	private refreshHistoryHandler: (() => Promise<void>) | null = null;

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

	setRefreshHistoryHandler(handler: () => Promise<void>) {
		this.refreshHistoryHandler = handler;
	}

	private registerHandlers() {
		this.bot.catch((error) => {
			console.error("Telegram bot error", error.error);
		});

		this.bot.command("start", async (ctx) => {
			if (!(await this.ensureAuthorizedUser(ctx))) {
				return;
			}
			if (!ctx.from) {
				return;
			}
			const chatId = ctx.chatId;
			if (chatId === undefined) {
				return;
			}

			this.db.upsertTelegramUser(ctx.from.id, chatId);
			await ctx.reply(
				"Welcome. Use /link to connect YouTube, then I will periodically send 5-question quizzes from your watch history.",
			);
		});

		this.bot.command("link", async (ctx) => {
			if (!(await this.ensureAuthorizedUser(ctx))) {
				return;
			}
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
			if (!(await this.ensureAuthorizedUser(ctx))) {
				return;
			}
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

		this.bot.command("stats", async (ctx) => {
			if (!(await this.ensureAuthorizedUser(ctx))) {
				return;
			}
			if (!ctx.from) {
				return;
			}

			const stats = this.db.getUserQuizStats(ctx.from.id);
			await ctx.reply(
				`Completed videos: ${stats.completedVideos}\nCorrect answers: ${stats.totalCorrectAnswers}/${stats.totalQuestions}\nAggregate score: ${stats.correctPercentage.toFixed(1)}%`,
			);
		});

		this.bot.command("refresh", async (ctx) => {
			if (!(await this.ensureAuthorizedUser(ctx))) {
				return;
			}

			if (!this.refreshHistoryHandler) {
				await ctx.reply("Refresh is not configured right now.");
				return;
			}

			await ctx.reply("Refreshing watch history now...");
			try {
				await this.refreshHistoryHandler();
				await ctx.reply("Refresh complete.");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await ctx.reply(`Refresh failed: ${message}`);
			}
		});

		this.bot.callbackQuery(/^hint:(\d+):(\d+)$/, async (ctx) => {
			if (!(await this.ensureAuthorizedUser(ctx))) {
				return;
			}

			const userId = Number.parseInt(ctx.match[1] ?? "", 10);
			const questionIndex = Number.parseInt(ctx.match[2] ?? "", 10);
			if (!ctx.from || ctx.from.id !== userId) {
				await ctx.answerCallbackQuery({
					text: "This hint button is not for you.",
					show_alert: false,
				});
				return;
			}

			const active = this.db.getActiveQuizSession(userId);
			const question = active?.questions[questionIndex];
			if (!active || !question) {
				await ctx.answerCallbackQuery({
					text: "This quiz is no longer active.",
					show_alert: false,
				});
				return;
			}

			const contextualHint =
				question.hint ??
				"Focus on the key claim or example discussed in the question.";

			const messageText = `Question ${questionIndex + 1}/${active.questions.length}\n${this.escapeHtml(question.prompt)}\n\nHint: ${this.escapeHtml(contextualHint)}\nReply with a short free-form answer.`;

			await ctx.editMessageText(messageText, {
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
			});

			await ctx.answerCallbackQuery({
				text: "Hint revealed",
				show_alert: false,
			});
		});

		this.bot.on("message:text", async (ctx) => {
			if (!(await this.ensureAuthorizedUser(ctx))) {
				return;
			}
			if (this.awaitingCookieInput.has(ctx.from?.id ?? -1)) {
				await this.handleCookieLinkMessage(ctx);
				return;
			}
			await this.handleQuizAnswer(ctx);
		});
	}

	private async ensureAuthorizedUser(ctx: Context): Promise<boolean> {
		const userId = ctx.from?.id;
		if (userId === undefined) {
			return false;
		}

		if (
			config.TELEGRAM_USER_ID_WHITELIST.length > 0 &&
			!config.TELEGRAM_USER_ID_WHITELIST.includes(userId)
		) {
			await ctx.reply("Access denied for this bot.");
			return false;
		}

		return true;
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

		const keyboard = new InlineKeyboard().text(
			"Reveal hint",
			`hint:${telegramUserId}:${active.currentQuestionIndex}`,
		);

		await this.bot.api.sendMessage(
			chatId,
			`Question ${active.currentQuestionIndex + 1}/${active.questions.length}\n${this.escapeHtml(question.prompt)}\n\nReply with a short free-form answer.`,
			{
				parse_mode: "HTML",
				link_preview_options: { is_disabled: true },
				reply_markup: keyboard,
			},
		);
	}

	private escapeHtml(value: string): string {
		return value
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;");
	}

	private async handleQuizAnswer(ctx: Context) {
		if (!ctx.from) {
			return;
		}

		const message = ctx.message;
		if (!message || !("text" in message)) {
			return;
		}
		const text = message.text;
		if (!text) {
			return;
		}

		const active = this.db.getActiveQuizSession(ctx.from.id);
		if (!active) {
			if (!text.startsWith("/")) {
				await ctx.reply("No active quiz right now. Use /refresh to check for new quizzes.");
			}
			return;
		}

		const question = active.questions[active.currentQuestionIndex];
		if (!question) {
			await ctx.reply(
				"I could not find the current quiz question. Use /status, then /refresh if needed.",
			);
			return;
		}

		const userAnswer = text.trim();

		let grade: { isCorrect: boolean; feedback: string };
		try {
			grade = await this.geminiService.gradeAnswer({
				question: question.prompt,
				correctAnswer: question.correctAnswer,
				sourceTimestamp: question.sourceTimestamp,
				userAnswer,
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			await ctx.reply(`I could not grade that answer right now. ${reason}`);
			return;
		}

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
