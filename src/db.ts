import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type {
	AppLinkedUser,
	LinkedUser,
	QuizPayload,
	YoutubeCookieJar,
} from "./types";

const ACTIVE_QUIZ_WINDOW_MS = 24 * 60 * 60 * 1000;

type LinkedUserRow = {
	telegram_user_id: number;
	chat_id: number;
	youtube_cookie_jar_json: string;
	last_polled_published_at: string | null;
};

type AppLinkedUserRow = {
	id: number;
	youtube_cookie_jar_json: string;
	last_polled_published_at: string | null;
};

const youtubeCookieSchema = z.object({
	value: z.string(),
	expiresAt: z.string().datetime().nullable(),
	domain: z.string().nullable(),
	path: z.string().nullable(),
	secure: z.boolean(),
	httpOnly: z.boolean(),
	sameSite: z.string().nullable(),
});

const youtubeCookieJarSchema = z.record(z.string(), youtubeCookieSchema);

type QuizRow = {
	id: number;
	telegram_user_id: number;
	chat_id: number;
	video_id: string;
	video_title: string;
	questions_json: string;
	current_question_index: number;
	current_question_message_id: number | null;
	score: number;
};

type CompletedQuizStatsRow = {
	questions_json: string;
	score: number;
};

type AppQuizRow = {
	id: number;
	app_user_id: number;
	video_id: string;
	video_title: string;
	questions_json: string;
	current_question_index: number;
	score: number;
	status: string;
};

type AppQuizAnswerRow = {
	question_index: number;
	user_answer: string;
	score: number;
	feedback: string;
};

export type AppUser = {
	id: number;
	appleSubject: string;
	email: string | null;
	youtubeLinked: boolean;
	notificationsEnabled: boolean;
};

export type UserQuizStats = {
	completedVideos: number;
	totalCorrectAnswers: number;
	totalQuestions: number;
	correctPercentage: number;
};

export type ActiveQuizSession = {
	id: number;
	telegramUserId: number;
	chatId: number;
	videoId: string;
	videoTitle: string;
	currentQuestionIndex: number;
	currentQuestionMessageId: number | null;
	score: number;
	questions: QuizPayload["questions"];
};

export type AppAvailableQuiz = {
	id: number;
	videoTitle: string;
	currentQuestionIndex: number;
	questionCount: number;
	score: number;
	status: string;
};

export type AppQuizSession = {
	id: number;
	appUserId: number;
	videoId: string;
	videoTitle: string;
	currentQuestionIndex: number;
	score: number;
	status: string;
	questions: QuizPayload["questions"];
};

export type AppQuizAnswer = {
	questionIndex: number;
	userAnswer: string;
	score: number;
	feedback: string;
};

export class AppDatabase {
	private db: Database;

	constructor(dbPath: string) {
		mkdirSync(dirname(dbPath), { recursive: true });
		this.db = new Database(dbPath);
		this.migrate();
	}

	private migrate() {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_user_id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        youtube_cookies_json TEXT,
        last_polled_published_at TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS quizzes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        video_id TEXT NOT NULL,
        video_title TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        current_question_index INTEGER NOT NULL DEFAULT 0,
        current_question_message_id INTEGER,
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(telegram_user_id, video_id)
      );

      CREATE TABLE IF NOT EXISTS app_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        apple_subject TEXT NOT NULL UNIQUE,
        email TEXT,
        youtube_cookies_json TEXT,
        last_polled_published_at TEXT,
        notifications_enabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (app_user_id) REFERENCES app_users(id)
      );

      CREATE TABLE IF NOT EXISTS app_quizzes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_user_id INTEGER NOT NULL,
        video_id TEXT NOT NULL,
        video_title TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        current_question_index INTEGER NOT NULL DEFAULT 0,
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (app_user_id) REFERENCES app_users(id),
        UNIQUE(app_user_id, video_id)
      );

      CREATE TABLE IF NOT EXISTS app_quiz_answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_quiz_id INTEGER NOT NULL,
        question_index INTEGER NOT NULL,
        user_answer TEXT NOT NULL,
        score REAL NOT NULL,
        feedback TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (app_quiz_id) REFERENCES app_quizzes(id),
        UNIQUE(app_quiz_id, question_index)
      );

      CREATE TABLE IF NOT EXISTS app_device_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_user_id INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (app_user_id) REFERENCES app_users(id)
      );
    `);

		try {
			this.db.exec("ALTER TABLE users ADD COLUMN youtube_cookies_json TEXT;");
		} catch {
			// Column already exists.
		}

		try {
			this.db.exec("ALTER TABLE users ADD COLUMN current_quiz_id INTEGER;");
		} catch {
			// Column already exists.
		}

		try {
			this.db.exec(
				"ALTER TABLE quizzes ADD COLUMN current_question_message_id INTEGER;",
			);
		} catch {
			// Column already exists.
		}

		try {
			this.db.exec(
				"ALTER TABLE app_users ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 0;",
			);
		} catch {
			// Column already exists.
		}
	}

	upsertAppleUser(input: { subject: string; email: string | null }): AppUser {
		const now = Date.now();
		this.db
			.query(
				`
        INSERT INTO app_users (apple_subject, email, created_at, updated_at)
        VALUES ($appleSubject, $email, $createdAt, $updatedAt)
        ON CONFLICT(apple_subject)
        DO UPDATE SET
          email = COALESCE($email, email),
          updated_at = $updatedAt
      `,
			)
			.run({
				$appleSubject: input.subject,
				$email: input.email,
				$createdAt: now,
				$updatedAt: now,
			});

		const user = this.getAppUserByAppleSubject(input.subject);
		if (!user) {
			throw new Error("Could not load app user after Apple sign in.");
		}
		return user;
	}

	createAppSession(input: {
		appUserId: number;
		token: string;
		expiresAt: Date;
	}) {
		this.db
			.query(
				`
        INSERT INTO app_sessions (app_user_id, token_hash, created_at, expires_at)
        VALUES ($appUserId, $tokenHash, $createdAt, $expiresAt)
      `,
			)
			.run({
				$appUserId: input.appUserId,
				$tokenHash: hashSessionToken(input.token),
				$createdAt: Date.now(),
				$expiresAt: input.expiresAt.getTime(),
			});
	}

	getAppUserBySessionToken(token: string | null): AppUser | null {
		if (!token) {
			return null;
		}

		const row = this.db
			.query(
				`
        SELECT
          app_users.id,
          app_users.apple_subject,
          app_users.email,
          app_users.youtube_cookies_json,
          app_users.notifications_enabled
        FROM app_sessions
        JOIN app_users ON app_users.id = app_sessions.app_user_id
        WHERE app_sessions.token_hash = $tokenHash
          AND app_sessions.expires_at > $now
        LIMIT 1
      `,
			)
			.get({
				$tokenHash: hashSessionToken(token),
				$now: Date.now(),
			}) as {
			id: number;
			apple_subject: string;
			email: string | null;
			youtube_cookies_json: string | null;
			notifications_enabled: number;
		} | null;

		return row ? appUserFromRow(row) : null;
	}

	saveAppYoutubeCookieJar(input: {
		appUserId: number;
		cookieJar: YoutubeCookieJar;
	}) {
		this.db
			.query(
				`
        UPDATE app_users
        SET youtube_cookies_json = $cookieJarJson,
            last_polled_published_at = $lastPolledPublishedAt,
            updated_at = $updatedAt
        WHERE id = $appUserId
      `,
			)
			.run({
				$appUserId: input.appUserId,
				$cookieJarJson: JSON.stringify(input.cookieJar),
				$lastPolledPublishedAt: new Date().toISOString(),
				$updatedAt: Date.now(),
			});
	}

	disconnectAppYoutube(appUserId: number) {
		this.db
			.query(
				`
        UPDATE app_users
        SET youtube_cookies_json = NULL,
            updated_at = $updatedAt
        WHERE id = $appUserId
      `,
			)
			.run({ $appUserId: appUserId, $updatedAt: Date.now() });
	}

	setAppNotificationsEnabled(input: {
		appUserId: number;
		notificationsEnabled: boolean;
	}) {
		this.db
			.query(
				`
        UPDATE app_users
        SET notifications_enabled = $notificationsEnabled,
            updated_at = $updatedAt
        WHERE id = $appUserId
      `,
			)
			.run({
				$appUserId: input.appUserId,
				$notificationsEnabled: input.notificationsEnabled ? 1 : 0,
				$updatedAt: Date.now(),
			});
	}

	saveAppDeviceToken(input: {
		appUserId: number;
		token: string;
		platform: string;
	}) {
		const now = Date.now();
		this.db
			.query(
				`
        INSERT INTO app_device_tokens (app_user_id, token, platform, created_at, updated_at)
        VALUES ($appUserId, $token, $platform, $createdAt, $updatedAt)
        ON CONFLICT(token)
        DO UPDATE SET
          app_user_id = $appUserId,
          platform = $platform,
          updated_at = $updatedAt
      `,
			)
			.run({
				$appUserId: input.appUserId,
				$token: input.token,
				$platform: input.platform,
				$createdAt: now,
				$updatedAt: now,
			});
	}

	listNotificationDeviceTokens(appUserId: number): string[] {
		const rows = this.db
			.query(
				`
        SELECT app_device_tokens.token
        FROM app_device_tokens
        JOIN app_users ON app_users.id = app_device_tokens.app_user_id
        WHERE app_device_tokens.app_user_id = $appUserId
          AND app_users.notifications_enabled = 1
      `,
			)
			.all({ $appUserId: appUserId }) as Array<{ token: string }>;

		return rows.map((row) => row.token);
	}

	getLinkedAppUsers(): AppLinkedUser[] {
		const rows = this.db
			.query(
				`
        SELECT
          id,
          youtube_cookies_json AS youtube_cookie_jar_json,
          last_polled_published_at
        FROM app_users
        WHERE youtube_cookies_json IS NOT NULL
      `,
			)
			.all() as AppLinkedUserRow[];

		const users: AppLinkedUser[] = [];
		for (const row of rows) {
			const parsed = this.parseYoutubeCookieJarJson(
				row.youtube_cookie_jar_json,
			);
			if (!parsed) {
				continue;
			}

			users.push({
				appUserId: row.id,
				youtubeCookieJar: parsed,
				lastPolledPublishedAt: row.last_polled_published_at ?? null,
			});
		}

		return users;
	}

	markAppVideoPolled(appUserId: number, publishedAt: string) {
		this.db
			.query(
				`
        UPDATE app_users
        SET last_polled_published_at = $publishedAt,
            updated_at = $updatedAt
        WHERE id = $appUserId
      `,
			)
			.run({
				$appUserId: appUserId,
				$publishedAt: publishedAt,
				$updatedAt: Date.now(),
			});
	}

	hasAppQuizForVideo(appUserId: number, videoId: string): boolean {
		const row = this.db
			.query(
				`SELECT id FROM app_quizzes WHERE app_user_id = $appUserId AND video_id = $videoId LIMIT 1`,
			)
			.get({ $appUserId: appUserId, $videoId: videoId });
		return Boolean(row);
	}

	countActiveAppQuizSessions(appUserId: number): number {
		const row = this.db
			.query(
				`
          SELECT COUNT(*) AS count
          FROM app_quizzes
          WHERE app_user_id = $appUserId
            AND status = 'active'
        `,
			)
			.get({ $appUserId: appUserId }) as { count?: number } | null;

		return row?.count ?? 0;
	}

	createAppQuizSession(appUserId: number, quiz: QuizPayload): number {
		const result = this.db
			.query(
				`
        INSERT INTO app_quizzes (
          app_user_id,
          video_id,
          video_title,
          questions_json,
          status,
          created_at
        )
        VALUES (
          $appUserId,
          $videoId,
          $videoTitle,
          $questionsJson,
          'active',
          $createdAt
        )
      `,
			)
			.run({
				$appUserId: appUserId,
				$videoId: quiz.videoId,
				$videoTitle: quiz.videoTitle,
				$questionsJson: JSON.stringify(quiz.questions),
				$createdAt: Date.now(),
			});
		return Number(result.lastInsertRowid);
	}

	listAppQuizzes(input: {
		appUserId: number;
		status: "active" | "completed";
	}): AppAvailableQuiz[] {
		const rows = this.db
			.query(
				`
        SELECT
          id,
          video_title,
          questions_json,
          current_question_index,
          score,
          status
        FROM app_quizzes
        WHERE app_user_id = $appUserId
          AND status = $status
        ORDER BY created_at DESC
      `,
			)
			.all({
				$appUserId: input.appUserId,
				$status: input.status,
			}) as AppQuizRow[];

		return rows.map((row) => ({
			id: row.id,
			videoTitle: row.video_title,
			currentQuestionIndex: row.current_question_index,
			questionCount: (JSON.parse(row.questions_json) as unknown[]).length,
			score: row.score,
			status: row.status,
		}));
	}

	getAppQuizSession(input: {
		appUserId: number;
		quizId: number;
	}): AppQuizSession | null {
		const row = this.db
			.query(
				`
        SELECT
          id,
          app_user_id,
          video_id,
          video_title,
          questions_json,
          current_question_index,
          score,
          status
        FROM app_quizzes
        WHERE id = $quizId
          AND app_user_id = $appUserId
        LIMIT 1
      `,
			)
			.get({
				$appUserId: input.appUserId,
				$quizId: input.quizId,
			}) as AppQuizRow | null;

		if (!row) {
			return null;
		}

		return appQuizSessionFromRow(row);
	}

	advanceAppQuizSession(input: {
		appUserId: number;
		quizId: number;
		nextQuestionIndex: number;
		nextScore: number;
	}) {
		this.db
			.query(
				`
        UPDATE app_quizzes
        SET current_question_index = $nextQuestionIndex,
            score = $nextScore
        WHERE id = $quizId
          AND app_user_id = $appUserId
      `,
			)
			.run({
				$appUserId: input.appUserId,
				$quizId: input.quizId,
				$nextQuestionIndex: input.nextQuestionIndex,
				$nextScore: input.nextScore,
			});
	}

	completeAppQuizSession(input: { appUserId: number; quizId: number }) {
		this.db
			.query(
				`
        UPDATE app_quizzes
        SET status = 'completed'
        WHERE id = $quizId
          AND app_user_id = $appUserId
      `,
			)
			.run({
				$appUserId: input.appUserId,
				$quizId: input.quizId,
			});
	}

	saveAppQuizAnswer(input: {
		appUserId: number;
		quizId: number;
		questionIndex: number;
		userAnswer: string;
		score: number;
		feedback: string;
	}) {
		this.db
			.query(
				`
        INSERT INTO app_quiz_answers (
          app_quiz_id,
          question_index,
          user_answer,
          score,
          feedback,
          created_at
        )
        SELECT
          id,
          $questionIndex,
          $userAnswer,
          $score,
          $feedback,
          $createdAt
        FROM app_quizzes
        WHERE id = $quizId
          AND app_user_id = $appUserId
        ON CONFLICT(app_quiz_id, question_index)
        DO UPDATE SET
          user_answer = $userAnswer,
          score = $score,
          feedback = $feedback,
          created_at = $createdAt
      `,
			)
			.run({
				$appUserId: input.appUserId,
				$quizId: input.quizId,
				$questionIndex: input.questionIndex,
				$userAnswer: input.userAnswer,
				$score: input.score,
				$feedback: input.feedback,
				$createdAt: Date.now(),
			});
	}

	listAppQuizAnswers(input: {
		appUserId: number;
		quizId: number;
	}): AppQuizAnswer[] {
		const rows = this.db
			.query(
				`
        SELECT
          app_quiz_answers.question_index,
          app_quiz_answers.user_answer,
          app_quiz_answers.score,
          app_quiz_answers.feedback
        FROM app_quiz_answers
        JOIN app_quizzes ON app_quizzes.id = app_quiz_answers.app_quiz_id
        WHERE app_quizzes.id = $quizId
          AND app_quizzes.app_user_id = $appUserId
        ORDER BY app_quiz_answers.question_index ASC
      `,
			)
			.all({
				$appUserId: input.appUserId,
				$quizId: input.quizId,
			}) as AppQuizAnswerRow[];

		return rows.map((row) => ({
			questionIndex: row.question_index,
			userAnswer: row.user_answer,
			score: row.score,
			feedback: row.feedback,
		}));
	}

	private getAppUserByAppleSubject(appleSubject: string): AppUser | null {
		const row = this.db
			.query(
				`
        SELECT id, apple_subject, email, youtube_cookies_json, notifications_enabled
        FROM app_users
        WHERE apple_subject = $appleSubject
        LIMIT 1
      `,
			)
			.get({ $appleSubject: appleSubject }) as {
			id: number;
			apple_subject: string;
			email: string | null;
			youtube_cookies_json: string | null;
			notifications_enabled: number;
		} | null;

		return row ? appUserFromRow(row) : null;
	}

	upsertTelegramUser(telegramUserId: number, chatId: number) {
		const now = Date.now();
		this.db
			.query(
				`
        INSERT INTO users (telegram_user_id, chat_id, created_at)
        VALUES ($telegramUserId, $chatId, $createdAt)
        ON CONFLICT(telegram_user_id)
        DO UPDATE SET chat_id = $chatId
      `,
			)
			.run({
				$telegramUserId: telegramUserId,
				$chatId: chatId,
				$createdAt: now,
			});
	}

	markVideoPolled(telegramUserId: number, publishedAt: string) {
		this.db
			.query(
				`
        UPDATE users
        SET last_polled_published_at = $publishedAt
        WHERE telegram_user_id = $telegramUserId
      `,
			)
			.run({
				$telegramUserId: telegramUserId,
				$publishedAt: publishedAt,
			});
	}

	resetPollBaseline(telegramUserId: number) {
		this.markVideoPolled(telegramUserId, new Date().toISOString());
	}

	saveYoutubeCookieJar(telegramUserId: number, cookieJar: YoutubeCookieJar) {
		const cookieJarJson = JSON.stringify(cookieJar);
		this.db
			.query(
				`
        UPDATE users
        SET youtube_cookies_json = $cookieJarJson
        WHERE telegram_user_id = $telegramUserId
      `,
			)
			.run({
				$telegramUserId: telegramUserId,
				$cookieJarJson: cookieJarJson,
			});
	}

	getLinkedUsers(): LinkedUser[] {
		const rows = this.db
			.query(
				`
        SELECT
          telegram_user_id,
          chat_id,
          youtube_cookies_json AS youtube_cookie_jar_json,
          last_polled_published_at
        FROM users
        WHERE youtube_cookies_json IS NOT NULL
      `,
			)
			.all() as LinkedUserRow[];

		const linkedUsers: LinkedUser[] = [];

		for (const row of rows) {
			const parsed = this.parseYoutubeCookieJarJson(
				row.youtube_cookie_jar_json,
			);
			if (!parsed) {
				continue;
			}

			linkedUsers.push({
				telegramUserId: row.telegram_user_id,
				chatId: row.chat_id,
				youtubeCookieJar: parsed,
				lastPolledPublishedAt: row.last_polled_published_at ?? null,
			});
		}

		return linkedUsers;
	}

	private parseYoutubeCookieJarJson(
		rawCookieJarJson: string,
	): YoutubeCookieJar | null {
		try {
			const parsedJson = JSON.parse(rawCookieJarJson) as unknown;
			const result = youtubeCookieJarSchema.safeParse(parsedJson);
			if (!result.success) {
				return null;
			}
			return result.data;
		} catch {
			return null;
		}
	}

	hasQuizForVideo(telegramUserId: number, videoId: string): boolean {
		const row = this.db
			.query(
				`SELECT id FROM quizzes WHERE telegram_user_id = $telegramUserId AND video_id = $videoId LIMIT 1`,
			)
			.get({ $telegramUserId: telegramUserId, $videoId: videoId });
		return Boolean(row);
	}

	createQuizSession(
		telegramUserId: number,
		chatId: number,
		quiz: QuizPayload,
	): number {
		const result = this.db
			.query(
				`
        INSERT INTO quizzes (
          telegram_user_id,
          chat_id,
          video_id,
          video_title,
          questions_json,
          status,
          created_at
        )
        VALUES (
          $telegramUserId,
          $chatId,
          $videoId,
          $videoTitle,
          $questionsJson,
          'active',
          $createdAt
        )
      `,
			)
			.run({
				$telegramUserId: telegramUserId,
				$chatId: chatId,
				$videoId: quiz.videoId,
				$videoTitle: quiz.videoTitle,
				$questionsJson: JSON.stringify(quiz.questions),
				$createdAt: Date.now(),
			});
		return Number(result.lastInsertRowid);
	}

	getActiveQuizSession(telegramUserId: number): ActiveQuizSession | null {
		const row = this.db
			.query(
				`
        SELECT
          id,
          telegram_user_id,
          chat_id,
          video_id,
          video_title,
          questions_json,
          current_question_index,
					current_question_message_id,
          score
	        FROM quizzes
	        WHERE telegram_user_id = $telegramUserId
	          AND status = 'active'
	          AND created_at >= $activeSince
	        ORDER BY created_at DESC
	        LIMIT 1
	      `,
			)
			.get({
				$telegramUserId: telegramUserId,
				$activeSince: Date.now() - ACTIVE_QUIZ_WINDOW_MS,
			}) as QuizRow | null;

		if (!row) {
			return null;
		}

		return {
			id: row.id,
			telegramUserId: row.telegram_user_id,
			chatId: row.chat_id,
			videoId: row.video_id,
			videoTitle: row.video_title,
			currentQuestionIndex: row.current_question_index,
			currentQuestionMessageId: row.current_question_message_id,
			score: row.score,
			questions: JSON.parse(row.questions_json) as QuizPayload["questions"],
		};
	}

	getQuizSession(quizId: number): ActiveQuizSession | null {
		const row = this.db
			.query(
				`
        SELECT
          id,
          telegram_user_id,
          chat_id,
          video_id,
          video_title,
          questions_json,
          current_question_index,
					current_question_message_id,
          score
        FROM quizzes
        WHERE id = $quizId
          AND status = 'active'
      `,
			)
			.get({ $quizId: quizId }) as QuizRow | null;

		if (!row) {
			return null;
		}

		return {
			id: row.id,
			telegramUserId: row.telegram_user_id,
			chatId: row.chat_id,
			videoId: row.video_id,
			videoTitle: row.video_title,
			currentQuestionIndex: row.current_question_index,
			currentQuestionMessageId: row.current_question_message_id,
			score: row.score,
			questions: JSON.parse(row.questions_json) as QuizPayload["questions"],
		};
	}

	getQuizSessionByQuestionMessage(input: {
		telegramUserId: number;
		chatId: number;
		messageId: number;
	}): ActiveQuizSession | null {
		const row = this.db
			.query(
				`
        SELECT
          id,
          telegram_user_id,
          chat_id,
          video_id,
          video_title,
          questions_json,
          current_question_index,
					current_question_message_id,
          score
        FROM quizzes
        WHERE telegram_user_id = $telegramUserId
          AND chat_id = $chatId
          AND current_question_message_id = $messageId
          AND status = 'active'
      `,
			)
			.get({
				$telegramUserId: input.telegramUserId,
				$chatId: input.chatId,
				$messageId: input.messageId,
			}) as QuizRow | null;

		if (!row) {
			return null;
		}

		return {
			id: row.id,
			telegramUserId: row.telegram_user_id,
			chatId: row.chat_id,
			videoId: row.video_id,
			videoTitle: row.video_title,
			currentQuestionIndex: row.current_question_index,
			currentQuestionMessageId: row.current_question_message_id,
			score: row.score,
			questions: JSON.parse(row.questions_json) as QuizPayload["questions"],
		};
	}

	setCurrentQuizId(telegramUserId: number, quizId: number) {
		this.db
			.query(
				`UPDATE users SET current_quiz_id = $quizId WHERE telegram_user_id = $telegramUserId`,
			)
			.run({ $telegramUserId: telegramUserId, $quizId: quizId });
	}

	clearCurrentQuizId(telegramUserId: number) {
		this.db
			.query(
				`UPDATE users SET current_quiz_id = NULL WHERE telegram_user_id = $telegramUserId`,
			)
			.run({ $telegramUserId: telegramUserId });
	}

	getCurrentQuizId(telegramUserId: number): number | null {
		const row = this.db
			.query(
				`SELECT current_quiz_id FROM users WHERE telegram_user_id = $telegramUserId`,
			)
			.get({ $telegramUserId: telegramUserId }) as {
			current_quiz_id?: number | null;
		} | null;
		return row?.current_quiz_id ?? null;
	}

	setCurrentQuestionMessageId(quizId: number, messageId: number) {
		this.db
			.query(
				`UPDATE quizzes SET current_question_message_id = $messageId WHERE id = $quizId`,
			)
			.run({ $quizId: quizId, $messageId: messageId });
	}

	countActiveQuizSessions(telegramUserId: number): number {
		const row = this.db
			.query(
				`
					SELECT COUNT(*) AS count
					FROM quizzes
					WHERE telegram_user_id = $telegramUserId
						AND status = 'active'
						AND created_at >= $activeSince
				`,
			)
			.get({
				$telegramUserId: telegramUserId,
				$activeSince: Date.now() - ACTIVE_QUIZ_WINDOW_MS,
			}) as { count?: number } | null;

		return row?.count ?? 0;
	}

	getChatIdForUser(telegramUserId: number): number | null {
		const row = this.db
			.query(
				`SELECT chat_id FROM users WHERE telegram_user_id = $telegramUserId LIMIT 1`,
			)
			.get({ $telegramUserId: telegramUserId }) as { chat_id?: number } | null;

		return row?.chat_id ?? null;
	}

	advanceQuizSession(
		quizId: number,
		nextQuestionIndex: number,
		nextScore: number,
	) {
		this.db
			.query(
				`
        UPDATE quizzes
        SET current_question_index = $nextQuestionIndex,
            score = $nextScore
        WHERE id = $quizId
      `,
			)
			.run({
				$quizId: quizId,
				$nextQuestionIndex: nextQuestionIndex,
				$nextScore: nextScore,
			});
	}

	completeQuizSession(quizId: number) {
		this.db
			.query(`UPDATE quizzes SET status = 'completed' WHERE id = $quizId`)
			.run({ $quizId: quizId });
	}

	getUserQuizStats(telegramUserId: number): UserQuizStats {
		const rows = this.db
			.query(
				`
        SELECT questions_json, score
        FROM quizzes
        WHERE telegram_user_id = $telegramUserId
          AND status = 'completed'
      `,
			)
			.all({ $telegramUserId: telegramUserId }) as CompletedQuizStatsRow[];

		const completedVideos = rows.length;
		const totalCorrectAnswers = rows.reduce(
			(total, row) => total + row.score,
			0,
		);
		const totalQuestions = rows.reduce((total, row) => {
			const questions = JSON.parse(row.questions_json) as unknown[];
			return total + questions.length;
		}, 0);
		const correctPercentage =
			totalQuestions === 0 ? 0 : (totalCorrectAnswers / totalQuestions) * 100;

		return {
			completedVideos,
			totalCorrectAnswers,
			totalQuestions,
			correctPercentage,
		};
	}
}

function hashSessionToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function appUserFromRow(row: {
	id: number;
	apple_subject: string;
	email: string | null;
	youtube_cookies_json: string | null;
	notifications_enabled: number;
}): AppUser {
	return {
		id: row.id,
		appleSubject: row.apple_subject,
		email: row.email,
		youtubeLinked: row.youtube_cookies_json !== null,
		notificationsEnabled: row.notifications_enabled === 1,
	};
}

function appQuizSessionFromRow(row: AppQuizRow): AppQuizSession {
	return {
		id: row.id,
		appUserId: row.app_user_id,
		videoId: row.video_id,
		videoTitle: row.video_title,
		currentQuestionIndex: row.current_question_index,
		score: row.score,
		status: row.status,
		questions: JSON.parse(row.questions_json) as QuizPayload["questions"],
	};
}
