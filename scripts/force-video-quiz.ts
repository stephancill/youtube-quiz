import { QuizBot } from "../src/bot";
import { config } from "../src/config";
import { AppDatabase } from "../src/db";
import { GeminiService } from "../src/gemini";

const db = new AppDatabase(config.DATABASE_PATH);
const geminiService = new GeminiService(config.GEMINI_API_KEY);
const quizBot = new QuizBot(db, geminiService);

const videoId = readStringArg("--video-id");
const telegramUserId = readNumberArg("--user-id");
const ignoreActiveLimit = process.argv.includes("--ignore-active-limit");

const chatId = db.getChatIdForUser(telegramUserId);
if (chatId === null) {
	throw new Error(`No linked chat found for user ${telegramUserId}`);
}

if (db.hasQuizForVideo(telegramUserId, videoId)) {
	console.log(
		JSON.stringify({ ok: true, message: "Quiz already exists for video" }),
	);
	process.exit(0);
}

const activeQuizCount = db.countActiveQuizSessions(telegramUserId);
if (!ignoreActiveLimit && activeQuizCount >= 3) {
	throw new Error(
		`User already has ${activeQuizCount} active quizzes. Complete one first.`,
	);
}

const metadata = await fetchVideoMetadata(videoId);
const quiz = await generateQuizWithFallback(
	videoId,
	metadata.title,
	metadata.authorName,
);

db.createQuizSession(telegramUserId, chatId, quiz);
await quizBot.sendQuizIntro({
	telegramUserId,
	chatId,
	videoId,
	videoTitle: metadata.title,
});

console.log(
	JSON.stringify({
		ok: true,
		videoId,
		telegramUserId,
		chatId,
		title: metadata.title,
	}),
);

async function generateQuizWithFallback(
	videoIdValue: string,
	videoTitle: string,
	channelTitle: string,
) {
	try {
		return await geminiService.generateQuiz({
			videoId: videoIdValue,
			videoTitle,
			channelTitle,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("input token count exceeds")) {
			throw error;
		}

		const questions = await generateFallbackQuestions(videoTitle, channelTitle);
		return {
			videoId: videoIdValue,
			videoTitle,
			questions,
		};
	}
}

async function generateFallbackQuestions(
	videoTitle: string,
	channelTitle: string,
) {
	const prompt = `Create exactly 5 free-response quiz questions based only on the likely content of this YouTube video.
Video title: ${videoTitle}
Channel: ${channelTitle}

Return strict JSON:
{"questions":[{"prompt":"...","correctAnswer":"...","sourceTimestamp":"MM:SS"}]}`;

	const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.GEMINI_API_KEY}`;
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ role: "user", parts: [{ text: prompt }] }],
			generationConfig: { responseMimeType: "application/json" },
		}),
	});

	if (!response.ok) {
		throw new Error(
			`Fallback quiz generation failed: ${await response.text()}`,
		);
	}

	const data = (await response.json()) as {
		candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
	};
	const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
	if (!text) {
		throw new Error("Fallback quiz generation returned empty response");
	}

	const parsed = JSON.parse(text) as {
		questions?: Array<{
			prompt?: string;
			correctAnswer?: string;
			sourceTimestamp?: string;
		}>;
	};

	const questions = (parsed.questions ?? []).slice(0, 5).map((question) => ({
		prompt: question.prompt ?? "",
		correctAnswer: question.correctAnswer ?? "",
		sourceTimestamp: question.sourceTimestamp ?? "00:00",
	}));

	if (
		questions.length !== 5 ||
		questions.some((question) => !question.prompt)
	) {
		throw new Error("Fallback quiz did not return 5 valid questions");
	}

	return questions;
}

async function fetchVideoMetadata(videoIdValue: string) {
	const videoUrl = `https://www.youtube.com/watch?v=${videoIdValue}`;
	const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
	const response = await fetch(endpoint);

	if (!response.ok) {
		throw new Error(`Failed to fetch video metadata for ${videoIdValue}`);
	}

	const data = (await response.json()) as {
		title?: string;
		author_name?: string;
	};

	return {
		title: data.title ?? videoIdValue,
		authorName: data.author_name ?? "Unknown channel",
	};
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
