import { AppDatabase } from "../src/db";
import { GeminiService } from "../src/gemini";
import { openclawConfig } from "../src/openclaw-config";
import type { QuizPayload } from "../src/types";
import { YoutubeService } from "../src/youtube";

const DEFAULT_SINGLE_USER_ID = 1;
const DEFAULT_SINGLE_CHAT_ID = 1;

type PollEvent = {
	type: "new_quiz";
	telegramUserId: number;
	chatId: number;
	videoId: string;
	videoTitle: string;
	intro: string;
	question: string;
};

type PollResult = {
	events: PollEvent[];
	errors: Array<{ telegramUserId: number; chatId: number; message: string }>;
};

type StatusResult =
	| {
			found: false;
			message: string;
	  }
	| {
			found: true;
			message: string;
	  };

const db = new AppDatabase(openclawConfig.DATABASE_PATH);
const youtubeService = new YoutubeService();
const geminiService = new GeminiService(openclawConfig.GEMINI_API_KEY);

async function main() {
	const command = process.argv[2];

	if (!command) {
		throw new Error("Missing command. Use: link | poll | status | answer");
	}

	switch (command) {
		case "link": {
			const telegramUserId = readOptionalNumberArg(
				"--user-id",
				DEFAULT_SINGLE_USER_ID,
			);
			const chatId = readOptionalNumberArg("--chat-id", DEFAULT_SINGLE_CHAT_ID);
			const cookieHeader = readStringArg("--cookie");

			db.upsertTelegramUser(telegramUserId, chatId);
			db.saveYoutubeCookieHeader(
				telegramUserId,
				normalizeCookieHeader(cookieHeader),
			);

			writeJson({
				ok: true,
				message:
					"YouTube cookie header saved. Heartbeat can now poll watch history for quizzes.",
			});
			return;
		}

		case "poll": {
			const result = await pollOnce();
			writeJson(result);
			return;
		}

		case "status": {
			const telegramUserId = readOptionalNumberArg(
				"--user-id",
				DEFAULT_SINGLE_USER_ID,
			);
			const status = getStatus(telegramUserId);
			writeJson(status);
			return;
		}

		case "answer": {
			const telegramUserId = readOptionalNumberArg(
				"--user-id",
				DEFAULT_SINGLE_USER_ID,
			);
			const answer = readStringArg("--answer").trim();
			const result = await submitAnswer(telegramUserId, answer);
			writeJson(result);
			return;
		}

		default:
			throw new Error(`Unknown command: ${command}`);
	}
}

async function pollOnce(): Promise<PollResult> {
	const linkedUsers = db.getLinkedUsers();
	const result: PollResult = { events: [], errors: [] };

	for (const user of linkedUsers) {
		try {
			let activeQuizCount = db.countActiveQuizSessions(user.telegramUserId);
			if (activeQuizCount >= 3) {
				continue;
			}
			const slotsAvailable = 3 - activeQuizCount;

			const videos = await youtubeService.listRecentWatchedVideos(
				user,
				openclawConfig.QUIZ_MAX_HISTORY_ITEMS,
				openclawConfig.MIN_WATCH_RATIO,
			);

			const unseen = videos
				.filter((video) => !db.hasQuizForVideo(user.telegramUserId, video.id))
				.sort((a, b) => (a.publishedAt > b.publishedAt ? -1 : 1));

			const selected = unseen.slice(0, slotsAvailable);
			let newestProcessedPublishedAt: string | null = null;

			for (const video of selected) {
				const quiz = await geminiService.generateQuiz({
					videoId: video.id,
					videoTitle: video.title,
					channelTitle: video.channelTitle,
				});

				db.createQuizSession(user.telegramUserId, user.chatId, quiz);
				result.events.push(toPollEvent(user.telegramUserId, user.chatId, quiz));

				if (
					!newestProcessedPublishedAt ||
					video.publishedAt > newestProcessedPublishedAt
				) {
					newestProcessedPublishedAt = video.publishedAt;
				}
				activeQuizCount += 1;
			}

			if (newestProcessedPublishedAt) {
				db.markVideoPolled(user.telegramUserId, newestProcessedPublishedAt);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.errors.push({
				telegramUserId: user.telegramUserId,
				chatId: user.chatId,
				message,
			});
		}
	}

	return result;
}

function getStatus(telegramUserId: number): StatusResult {
	const active = db.getActiveQuizSession(telegramUserId);
	if (!active) {
		return {
			found: false,
			message:
				"No active quiz. Heartbeat will notify when a newly watched eligible video appears.",
		};
	}

	return {
		found: true,
		message: `Active quiz: ${active.videoTitle}. Question ${active.currentQuestionIndex + 1} of ${active.questions.length}. Score: ${active.score}.`,
	};
}

async function submitAnswer(telegramUserId: number, answer: string) {
	if (!answer) {
		throw new Error("Answer must not be empty");
	}

	const active = db.getActiveQuizSession(telegramUserId);
	if (!active) {
		return {
			found: false,
			message: "No active quiz.",
		};
	}

	const question = active.questions[active.currentQuestionIndex];
	if (!question) {
		return {
			found: false,
			message: "No active quiz question found.",
		};
	}

	const grade = await geminiService.gradeAnswer({
		question: question.prompt,
		correctAnswer: question.correctAnswer,
		sourceTimestamp: question.sourceTimestamp,
		userAnswer: answer,
	});

	const nextScore = grade.isCorrect ? active.score + 1 : active.score;
	const nextIndex = active.currentQuestionIndex + 1;
	db.advanceQuizSession(active.id, nextIndex, nextScore);

	if (nextIndex >= active.questions.length) {
		db.completeQuizSession(active.id);
		return {
			found: true,
			completed: true,
			message: `${grade.isCorrect ? "Correct" : "Not quite"}. ${grade.feedback}\n\nQuiz complete. Final score: ${nextScore}/${active.questions.length}`,
		};
	}

	const nextQuestion = active.questions[nextIndex];
	return {
		found: true,
		completed: false,
		message: `${grade.isCorrect ? "Correct" : "Not quite"}. ${grade.feedback}\n\nQuestion ${nextIndex + 1}/${active.questions.length}\n${nextQuestion?.prompt}\n\nHint: relevant moment around ${nextQuestion?.sourceTimestamp}.`,
	};
}

function toPollEvent(
	telegramUserId: number,
	chatId: number,
	quiz: QuizPayload,
): PollEvent {
	const question = quiz.questions[0];
	const videoUrl = `https://www.youtube.com/watch?v=${quiz.videoId}`;
	return {
		type: "new_quiz",
		telegramUserId,
		chatId,
		videoId: quiz.videoId,
		videoTitle: quiz.videoTitle,
		intro: `New quiz unlocked from your watch history:\n${quiz.videoTitle}\n${videoUrl}`,
		question: `Question 1/${quiz.questions.length}\n${question?.prompt}\n\nHint: relevant moment around ${question?.sourceTimestamp}. Reply with a short free-form answer.`,
	};
}

function normalizeCookieHeader(input: string): string {
	const normalized = input.trim();
	if (!normalized) {
		throw new Error("Cookie header is empty");
	}

	const pairs = normalized
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);

	if (pairs.length === 0 || pairs.every((pair) => !pair.includes("="))) {
		throw new Error("Cookie header must include key=value pairs");
	}

	return pairs.join("; ");
}

function readStringArg(flag: string): string {
	const index = process.argv.indexOf(flag);
	if (index === -1) {
		throw new Error(`Missing required argument: ${flag}`);
	}
	const value = process.argv[index + 1];
	if (!value) {
		throw new Error(`Missing value for argument: ${flag}`);
	}
	return value;
}

function readNumberArg(flag: string): number {
	const value = Number.parseInt(readStringArg(flag), 10);
	if (Number.isNaN(value)) {
		throw new Error(`Invalid numeric value for argument: ${flag}`);
	}
	return value;
}

function readOptionalNumberArg(flag: string, fallback: number): number {
	const index = process.argv.indexOf(flag);
	if (index === -1) {
		return fallback;
	}
	return readNumberArg(flag);
}

function writeJson(value: unknown) {
	console.log(JSON.stringify(value));
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});
