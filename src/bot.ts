import { Bot, type Context, InlineKeyboard } from "grammy";
import { config } from "./config";
import type { AppDatabase } from "./db";
import type { GeminiService } from "./gemini";
import type { YoutubeCookieJar } from "./types";
import type { YoutubeService } from "./youtube";

export class QuizBot {
	private bot: Bot;
	private awaitingCookieInput = new Set<number>();
	private refreshHistoryHandler: (() => Promise<void>) | null = null;

	constructor(
		private db: AppDatabase,
		private geminiService: GeminiService,
		private youtubeService: YoutubeService,
	) {
		this.bot = new Bot(config.TELEGRAM_BOT_TOKEN);
		this.registerHandlers();
	}

	async start() {
		await this.bot.start();
		await this.bot.api.setMyCommands([
			{ command: "start", description: "Start the bot" },
			{ command: "link", description: "Link your YouTube account" },
			{ command: "status", description: "Show active quiz" },
			{ command: "stats", description: "Show quiz statistics" },
			{ command: "refresh", description: "Refresh watch history now" },
		]);
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
				`Completed videos: ${stats.completedVideos}\nScore: ${stats.totalCorrectAnswers}/${stats.totalQuestions}\nAggregate: ${stats.correctPercentage.toFixed(1)}%`,
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

		this.bot.callbackQuery(/^hint:(\d+):(\d+):(\d+)$/, async (ctx) => {
			if (!(await this.ensureAuthorizedUser(ctx))) {
				return;
			}

			const quizId = Number.parseInt(ctx.match[1] ?? "", 10);
			const userId = Number.parseInt(ctx.match[2] ?? "", 10);
			const questionIndex = Number.parseInt(ctx.match[3] ?? "", 10);
			if (!ctx.from || ctx.from.id !== userId) {
				await ctx.answerCallbackQuery({
					text: "This hint button is not for you.",
					show_alert: false,
				});
				return;
			}

			const active = this.db.getQuizSession(quizId);
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
			const cookieJar = this.parseCookieJarFromHeader(message.text);
			await ctx.reply("Testing YouTube cookie access now...");
			const validatedCookieJar = await this.youtubeService.validateCookieJar({
				telegramUserId: ctx.from.id,
				cookieJar,
			});
			this.db.saveYoutubeCookieJar(ctx.from.id, validatedCookieJar);
			this.db.resetPollBaseline(ctx.from.id);
			this.awaitingCookieInput.delete(ctx.from.id);
			await ctx.reply(
				"Cookie jar saved and verified. I will now poll your history feed and generate quizzes.",
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Invalid cookie header";
			await ctx.reply(
				`Could not verify cookie header: ${message}. Paste a fresh semicolon-separated Cookie header string from an authenticated YouTube tab, like SID=...; HSID=...; SAPISID=...`,
			);
		}
	}

	private parseCookieJarFromHeader(input: string): YoutubeCookieJar {
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

		const cookieJar: YoutubeCookieJar = {};

		for (const pair of pairs) {
			const separatorIndex = pair.indexOf("=");
			if (separatorIndex <= 0) {
				continue;
			}

			const cookieName = pair.slice(0, separatorIndex).trim();
			const cookieValue = pair.slice(separatorIndex + 1);
			if (!cookieName) {
				continue;
			}

			cookieJar[cookieName] = {
				value: cookieValue,
				expiresAt: null,
				domain: null,
				path: null,
				secure: false,
				httpOnly: false,
				sameSite: null,
			};
		}

		if (Object.keys(cookieJar).length === 0) {
			throw new Error("missing key=value pairs");
		}

		return cookieJar;
	}

	async sendQuizIntro(input: {
		quizId: number;
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
		await this.sendCurrentQuestion(
			input.quizId,
			input.telegramUserId,
			input.chatId,
		);
	}

	async sendCurrentQuestion(
		quizId: number,
		telegramUserId: number,
		chatId: number,
	) {
		const active = this.db.getQuizSession(quizId);
		if (!active) {
			return;
		}

		this.db.setCurrentQuizId(telegramUserId, quizId);

		const question = active.questions[active.currentQuestionIndex];
		if (!question) {
			return;
		}

		const keyboard = new InlineKeyboard().text(
			"Reveal hint",
			`hint:${quizId}:${telegramUserId}:${active.currentQuestionIndex}`,
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

		const quizId = this.db.getCurrentQuizId(ctx.from.id);
		const active = quizId
			? this.db.getQuizSession(quizId)
			: this.db.getActiveQuizSession(ctx.from.id);
		if (!active) {
			if (!text.startsWith("/")) {
				await ctx.reply(
					"No active quiz right now. Use /refresh to check for new quizzes.",
				);
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

		let grade: { score: number; feedback: string };
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

		const nextScore = active.score + grade.score;
		const nextIndex = active.currentQuestionIndex + 1;
		this.db.advanceQuizSession(active.id, nextIndex, nextScore);

		const scoreLabel =
			grade.score === 1
				? "Correct"
				: grade.score >= 0.5
					? "Partially correct"
					: "Not quite";
		const correctAnswerSuffix =
			grade.score === 0 ? `\n\nCorrect answer: ${question.correctAnswer}` : "";

		await ctx.reply(`${scoreLabel}. ${grade.feedback}${correctAnswerSuffix}`);

		if (nextIndex >= active.questions.length) {
			this.db.completeQuizSession(active.id);
			this.db.clearCurrentQuizId(ctx.from.id);
			await ctx.reply(
				`Quiz complete. Final score: ${nextScore}/${active.questions.length}`,
			);
			return;
		}

		await this.sendCurrentQuestion(
			active.id,
			ctx.from.id,
			ctx.chat?.id ?? active.chatId,
		);
	}
}
