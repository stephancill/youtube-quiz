import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LinkedUser, QuizPayload } from "./types";

type LinkedUserRow = {
	telegram_user_id: number;
	chat_id: number;
	youtube_cookie_header: string;
	last_polled_published_at: string | null;
};

type QuizRow = {
	id: number;
	telegram_user_id: number;
	chat_id: number;
	video_id: string;
	video_title: string;
	questions_json: string;
	current_question_index: number;
	score: number;
};

export type ActiveQuizSession = {
	id: number;
	telegramUserId: number;
	chatId: number;
	videoId: string;
	videoTitle: string;
	currentQuestionIndex: number;
	score: number;
	questions: QuizPayload["questions"];
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
        score INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(telegram_user_id, video_id)
      );
    `);

		try {
			this.db.exec("ALTER TABLE users ADD COLUMN youtube_cookies_json TEXT;");
		} catch {
			// Column already exists.
		}
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

	saveYoutubeCookieHeader(telegramUserId: number, cookieHeader: string) {
		this.db
			.query(
				`
        UPDATE users
        SET youtube_cookies_json = $cookieHeader
        WHERE telegram_user_id = $telegramUserId
      `,
			)
			.run({
				$telegramUserId: telegramUserId,
				$cookieHeader: cookieHeader,
			});
	}

	getLinkedUsers(): LinkedUser[] {
		const rows = this.db
			.query(
				`
        SELECT
          telegram_user_id,
          chat_id,
          youtube_cookies_json AS youtube_cookie_header,
          last_polled_published_at
        FROM users
        WHERE youtube_cookies_json IS NOT NULL
      `,
			)
			.all() as LinkedUserRow[];

		return rows.map((row) => ({
			telegramUserId: row.telegram_user_id,
			chatId: row.chat_id,
			youtubeCookieHeader: row.youtube_cookie_header,
			lastPolledPublishedAt: row.last_polled_published_at ?? null,
		}));
	}

	hasQuizForVideo(telegramUserId: number, videoId: string): boolean {
		const row = this.db
			.query(
				`SELECT id FROM quizzes WHERE telegram_user_id = $telegramUserId AND video_id = $videoId LIMIT 1`,
			)
			.get({ $telegramUserId: telegramUserId, $videoId: videoId });
		return Boolean(row);
	}

	createQuizSession(telegramUserId: number, chatId: number, quiz: QuizPayload) {
		this.db
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
          score
        FROM quizzes
        WHERE telegram_user_id = $telegramUserId
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      `,
			)
			.get({ $telegramUserId: telegramUserId }) as QuizRow | null;

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
			score: row.score,
			questions: JSON.parse(row.questions_json) as QuizPayload["questions"],
		};
	}

	countActiveQuizSessions(telegramUserId: number): number {
		const row = this.db
			.query(
				`SELECT COUNT(*) AS count FROM quizzes WHERE telegram_user_id = $telegramUserId AND status = 'active'`,
			)
			.get({ $telegramUserId: telegramUserId }) as { count?: number } | null;

		return row?.count ?? 0;
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
}
