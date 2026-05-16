import { mkdir, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { sendApnsNotification } from "./apns";
import { verifyAppleIdentityToken } from "./apple-auth";
import { config } from "./config";
import { parseYoutubeCookieJarFromHeader } from "./cookies";
import type { AppDatabase, AppUser } from "./db";
import type { GeminiService } from "./gemini";
import type { YoutubeCookieJar } from "./types";
import type { YoutubeHistorySourceDebug, YoutubeService } from "./youtube";

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 128 * 1024;
const DEBUG_HTML_DIR = "logs/youtube-history-source";

type ApiServerInput = {
	db: AppDatabase;
	geminiService: GeminiService;
	youtubeService: YoutubeService;
};

const answerBodySchema = z.object({
	answer: z.string().trim().min(1),
});

const notificationSettingsBodySchema = z.object({
	notificationsEnabled: z.boolean(),
});

const deviceTokenBodySchema = z.object({
	token: z.string().regex(/^[0-9a-fA-F]+$/),
});

export function createApiServer(input: ApiServerInput) {
	return createServer(async (req, res) => {
		const startedAt = Date.now();
		const method = req.method ?? "UNKNOWN";
		const path = req.url ?? "/";

		res.on("finish", () => {
			console.log(
				`[api] ${method} ${path} status=${res.statusCode} elapsed_ms=${Date.now() - startedAt}`,
			);
		});

		try {
			await handleRequest(input, req, res);
		} catch (error) {
			const message = error instanceof Error ? error.message : "server error";
			console.error(`[api] ${method} ${path} error=${message}`);
			writeJson(res, 500, { error: message });
		}
	});
}

async function handleRequest(
	input: ApiServerInput,
	req: IncomingMessage,
	res: ServerResponse,
) {
	const url = new URL(req.url ?? "/", "http://localhost");

	if (
		req.method === "GET" &&
		(url.pathname === "/" || url.pathname === "/health")
	) {
		writeJson(res, 200, { ok: true });
		return;
	}

	if (req.method === "POST" && url.pathname === "/auth/apple") {
		const body = await readJsonBody<{ identityToken?: string }>(req);
		if (!body.identityToken) {
			writeJson(res, 400, { error: "identityToken is required" });
			return;
		}

		const identity = await verifyAppleIdentityToken(body.identityToken);
		if (!isAppleIdentityAllowed(identity)) {
			writeJson(res, 403, { error: "Apple account is not allowed" });
			return;
		}

		const user = input.db.upsertAppleUser(identity);
		const sessionToken = crypto.randomUUID() + crypto.randomUUID();
		const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
		input.db.createAppSession({
			appUserId: user.id,
			token: sessionToken,
			expiresAt,
		});

		writeJson(res, 200, {
			sessionToken,
			expiresAt: expiresAt.toISOString(),
			user: appUserResponse(user),
		});
		return;
	}

	const authedUser = input.db.getAppUserBySessionToken(getBearerToken(req));
	if (!authedUser) {
		writeJson(res, 401, { error: "unauthorized" });
		return;
	}

	if (req.method === "GET" && url.pathname === "/me") {
		writeJson(res, 200, {
			user: appUserResponse(authedUser),
		});
		return;
	}

	if (req.method === "PUT" && url.pathname === "/settings/notifications") {
		const body = notificationSettingsBodySchema.parse(
			await readJsonBody<unknown>(req),
		);
		input.db.setAppNotificationsEnabled({
			appUserId: authedUser.id,
			notificationsEnabled: body.notificationsEnabled,
		});
		writeJson(res, 200, {
			user: appUserResponse({
				...authedUser,
				notificationsEnabled: body.notificationsEnabled,
			}),
		});
		return;
	}

	if (req.method === "POST" && url.pathname === "/settings/device-token") {
		const body = deviceTokenBodySchema.parse(await readJsonBody<unknown>(req));
		input.db.saveAppDeviceToken({
			appUserId: authedUser.id,
			token: body.token.toLowerCase(),
			platform: "ios",
		});
		writeJson(res, 200, {});
		return;
	}

	if (req.method === "POST" && url.pathname === "/debug/notifications/test") {
		await notifyAppUser({
			db: input.db,
			appUserId: authedUser.id,
			title: "YouTube Quiz",
			body: "Notifications are working.",
		});
		writeJson(res, 200, { ok: true });
		return;
	}

	if (req.method === "DELETE" && url.pathname === "/youtube/cookies") {
		input.db.disconnectAppYoutube(authedUser.id);
		writeJson(res, 200, {
			user: appUserResponse({ ...authedUser, youtubeLinked: false }),
		});
		return;
	}

	if (req.method === "GET" && url.pathname === "/quizzes") {
		writeJson(res, 200, {
			quizzes: input.db.listAppQuizzes({
				appUserId: authedUser.id,
				status: "active",
			}),
			history: input.db.listAppQuizzes({
				appUserId: authedUser.id,
				status: "completed",
			}),
		});
		return;
	}

	const quizDetailMatch = url.pathname.match(/^\/quizzes\/(\d+)$/);
	if (req.method === "GET" && quizDetailMatch?.[1]) {
		const quiz = input.db.getAppQuizSession({
			appUserId: authedUser.id,
			quizId: Number.parseInt(quizDetailMatch[1], 10),
		});
		if (!quiz) {
			writeJson(res, 404, { error: "quiz not found" });
			return;
		}

		writeJson(
			res,
			200,
			appQuizDetailResponse({ db: input.db, appUserId: authedUser.id, quiz }),
		);
		return;
	}

	const quizAnswerMatch = url.pathname.match(/^\/quizzes\/(\d+)\/answer$/);
	if (req.method === "POST" && quizAnswerMatch?.[1]) {
		const quizId = Number.parseInt(quizAnswerMatch[1], 10);
		const quiz = input.db.getAppQuizSession({
			appUserId: authedUser.id,
			quizId,
		});
		if (!quiz || quiz.status !== "active") {
			writeJson(res, 404, { error: "active quiz not found" });
			return;
		}

		const question = quiz.questions[quiz.currentQuestionIndex];
		if (!question) {
			input.db.completeAppQuizSession({ appUserId: authedUser.id, quizId });
			writeJson(res, 409, { error: "quiz is already complete" });
			return;
		}

		const body = answerBodySchema.parse(await readJsonBody<unknown>(req));
		const grade = await input.geminiService.gradeAnswer({
			question: question.prompt,
			correctAnswer: question.correctAnswer,
			sourceTimestamp: question.sourceTimestamp,
			userAnswer: body.answer,
		});
		const nextQuestionIndex = quiz.currentQuestionIndex + 1;
		const nextScore = quiz.score + grade.score;
		input.db.saveAppQuizAnswer({
			appUserId: authedUser.id,
			quizId,
			questionIndex: quiz.currentQuestionIndex,
			userAnswer: body.answer,
			score: grade.score,
			feedback: grade.feedback,
		});
		input.db.advanceAppQuizSession({
			appUserId: authedUser.id,
			quizId,
			nextQuestionIndex,
			nextScore,
		});

		const completed = nextQuestionIndex >= quiz.questions.length;
		if (completed) {
			input.db.completeAppQuizSession({ appUserId: authedUser.id, quizId });
		}

		const updatedQuiz = input.db.getAppQuizSession({
			appUserId: authedUser.id,
			quizId,
		});

		writeJson(res, 200, {
			grade,
			completed,
			quiz: updatedQuiz
				? appQuizDetailResponse({
						db: input.db,
						appUserId: authedUser.id,
						quiz: updatedQuiz,
					}).quiz
				: null,
		});
		return;
	}

	if (req.method === "PUT" && url.pathname === "/youtube/cookies") {
		const body = await readJsonBody<{ cookieHeader?: string }>(req);
		if (!body.cookieHeader) {
			writeJson(res, 400, { error: "cookieHeader is required" });
			return;
		}

		const cookieJar = parseYoutubeCookieJarFromHeader(body.cookieHeader);
		let validatedCookieJar: YoutubeCookieJar;
		try {
			validatedCookieJar = await input.youtubeService.validateCookieJar({
				telegramUserId: -authedUser.id,
				cookieJar,
			});
		} catch (error) {
			const debug = await input.youtubeService.fetchHistorySourceDebug({
				telegramUserId: -authedUser.id,
				cookieJar,
			});
			const debugPath = await saveHistorySourceDebug({
				appUserId: authedUser.id,
				debug,
			});
			const message = error instanceof Error ? error.message : "server error";
			throw new Error(
				`${message} Saved YouTube history source to ${debugPath}.`,
			);
		}
		input.db.saveAppYoutubeCookieJar({
			appUserId: authedUser.id,
			cookieJar: validatedCookieJar,
		});

		writeJson(res, 200, { youtubeLinked: true });
		return;
	}

	if (
		req.method === "PUT" &&
		url.pathname === "/debug/youtube/history-source"
	) {
		const body = await readJsonBody<{ cookieHeader?: string }>(req);
		if (!body.cookieHeader) {
			writeJson(res, 400, { error: "cookieHeader is required" });
			return;
		}

		const debug = await input.youtubeService.fetchHistorySourceDebug({
			telegramUserId: -authedUser.id,
			cookieJar: parseYoutubeCookieJarFromHeader(body.cookieHeader),
		});
		const debugPath = await saveHistorySourceDebug({
			appUserId: authedUser.id,
			debug,
		});

		writeJson(res, 200, { ...debug, debugPath });
		return;
	}

	writeJson(res, 404, { error: "not found" });
}

function isAppleIdentityAllowed(identity: {
	subject: string;
	email: string | null;
}): boolean {
	const subjectAllowed = config.APPLE_SUBJECT_WHITELIST.includes(
		identity.subject,
	);
	const emailAllowed = identity.email
		? config.APPLE_EMAIL_WHITELIST.includes(identity.email.toLowerCase())
		: false;

	if (
		config.APPLE_EMAIL_WHITELIST.length === 0 &&
		config.APPLE_SUBJECT_WHITELIST.length === 0
	) {
		return true;
	}

	return subjectAllowed || emailAllowed;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;

	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.byteLength;
		if (totalBytes > MAX_BODY_BYTES) {
			throw new Error("request body too large");
		}
		chunks.push(buffer);
	}

	const rawBody = Buffer.concat(chunks).toString("utf8");
	return rawBody ? (JSON.parse(rawBody) as T) : ({} as T);
}

function appQuizDetailResponse(input: {
	db: AppDatabase;
	appUserId: number;
	quiz: ReturnType<AppDatabase["getAppQuizSession"]>;
}) {
	if (!input.quiz) {
		throw new Error("quiz not found");
	}

	const quiz = input.quiz;
	const currentQuestion = quiz.questions[quiz.currentQuestionIndex] ?? null;
	const answers = new Map(
		input.db
			.listAppQuizAnswers({ appUserId: input.appUserId, quizId: quiz.id })
			.map((answer) => [answer.questionIndex, answer]),
	);
	return {
		quiz: {
			id: quiz.id,
			videoId: quiz.videoId,
			videoTitle: quiz.videoTitle,
			currentQuestionIndex: quiz.currentQuestionIndex,
			questionCount: quiz.questions.length,
			score: quiz.score,
			status: quiz.status,
			currentQuestion: currentQuestion
				? {
						prompt: currentQuestion.prompt,
						sourceTimestamp: currentQuestion.sourceTimestamp,
						hint: currentQuestion.hint ?? null,
					}
				: null,
			questions:
				quiz.status === "completed"
					? quiz.questions.map((question, questionIndex) => {
							const answer = answers.get(questionIndex);
							return {
								prompt: question.prompt,
								correctAnswer: question.correctAnswer,
								sourceTimestamp: question.sourceTimestamp,
								hint: question.hint ?? null,
								result: answer
									? {
											userAnswer: answer.userAnswer,
											score: answer.score,
											feedback: answer.feedback,
										}
									: null,
							};
						})
					: [],
		},
	};
}

function getBearerToken(req: IncomingMessage): string | null {
	const authorization = req.headers.authorization;
	if (!authorization?.startsWith("Bearer ")) {
		return null;
	}
	return authorization.slice("Bearer ".length).trim();
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

function appUserResponse(user: AppUser) {
	return {
		id: user.id,
		email: user.email,
		youtubeLinked: user.youtubeLinked,
		notificationsEnabled: user.notificationsEnabled,
	};
}

async function notifyAppUser(input: {
	db: AppDatabase;
	appUserId: number;
	title: string;
	body: string;
}) {
	const tokens = input.db.listNotificationDeviceTokens(input.appUserId);
	await Promise.all(
		tokens.map((deviceToken) =>
			sendApnsNotification({
				deviceToken,
				payload: { title: input.title, body: input.body },
			}),
		),
	);
}

async function saveHistorySourceDebug(input: {
	appUserId: number;
	debug: YoutubeHistorySourceDebug;
}): Promise<string> {
	await mkdir(DEBUG_HTML_DIR, { recursive: true });
	const timestamp = new Date().toISOString().replaceAll(":", "-");
	const baseName = `app-user-${input.appUserId}-${timestamp}`;
	const firstPath = join(DEBUG_HTML_DIR, `${baseName}-first.html`);
	const finalPath = join(DEBUG_HTML_DIR, `${baseName}-final.html`);
	const browsePath = join(DEBUG_HTML_DIR, `${baseName}-browse.json`);
	const metadataPath = join(DEBUG_HTML_DIR, `${baseName}.json`);

	await Promise.all([
		writeFile(firstPath, input.debug.first.html),
		writeFile(finalPath, input.debug.final.html),
		writeFile(browsePath, JSON.stringify(input.debug.browse.json, null, 2)),
		writeFile(
			metadataPath,
			JSON.stringify(
				{
					...input.debug,
					first: { ...input.debug.first, html: undefined },
					final: { ...input.debug.final, html: undefined },
					browse: { ...input.debug.browse, json: undefined },
					files: { first: firstPath, final: finalPath, browse: browsePath },
				},
				null,
				2,
			),
		),
	]);

	return finalPath;
}
