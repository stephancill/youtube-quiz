import { z } from "zod";
import type { GradeResult, QuizPayload } from "./types";

const GEMINI_ENDPOINT =
	"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const quizSchema = z.object({
	questions: z
		.array(
			z.object({
				prompt: z.string().min(1),
				correctAnswer: z.string().min(1),
				sourceTimestamp: z.string().regex(/^\d{2}:\d{2}$/),
				hint: z.string().min(1),
			}),
		)
		.length(5),
});

const gradeSchema = z.object({
	isCorrect: z.boolean(),
	feedback: z.string().min(1),
});

export class GeminiService {
	constructor(private apiKey: string) {}

	async generateQuiz(input: {
		videoId: string;
		videoTitle: string;
		channelTitle: string;
	}): Promise<QuizPayload> {
		const videoUrl = `https://www.youtube.com/watch?v=${input.videoId}`;
		const prompt = `You are creating a quiz from the ACTUAL CONTENT of a YouTube video provided as file_data.

Metadata (for context only):
- Video title: ${input.videoTitle}
- Channel: ${input.channelTitle}
- Video URL: ${videoUrl}

Requirements:
- Use information from the video itself, not just the title.
- Produce exactly 5 free-response questions.
- Each question must have:
  - prompt: concrete question about facts/claims/examples in the video
  - correctAnswer: concise canonical answer
  - sourceTimestamp: MM:SS where the answer is supported in the video
  - hint: one short contextual clue that helps recall the answer without revealing it directly
- Questions must be specific enough that a user who watched the video can answer from memory.
- Do NOT ask meta questions like "what is this video about".

If the video cannot be accessed or analyzed, return:
{"questions":[]}

Return strict JSON only:
{
  "questions": [
     {
       "prompt": "...",
       "correctAnswer": "...",
       "sourceTimestamp": "MM:SS",
       "hint": "..."
     }
   ]
 }`;

		const raw = await this.generateJson([
			{ text: prompt },
			{
				file_data: {
					file_uri: videoUrl,
				},
			},
		]);
		const parsed = quizSchema.parse(raw);
		if (parsed.questions.length !== 5) {
			throw new Error(
				"Gemini could not ground quiz questions in video content",
			);
		}
		return {
			videoId: input.videoId,
			videoTitle: input.videoTitle,
			questions: parsed.questions,
		};
	}

	async gradeAnswer(input: {
		question: string;
		correctAnswer: string;
		sourceTimestamp?: string;
		userAnswer: string;
	}): Promise<GradeResult> {
		const prompt = `Judge whether the user's answer should be treated as correct.
Question: ${input.question}
Correct answer: ${input.correctAnswer}
Reference timestamp in source video: ${input.sourceTimestamp ?? "unknown"}
User answer: ${input.userAnswer}

Rules:
- Mark true if user answer is equivalent in meaning, even if wording differs.
- Mark false for vague or unrelated answers.
- Keep feedback to one short sentence.

Return strict JSON only:
{
  "isCorrect": true,
  "feedback": "..."
}`;

		const raw = await this.generateJson([{ text: prompt }]);
		return gradeSchema.parse(raw);
	}

	private async generateJson(
		parts: Array<Record<string, unknown>>,
	): Promise<unknown> {
		const response = await fetch(`${GEMINI_ENDPOINT}?key=${this.apiKey}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ role: "user", parts }],
				generationConfig: {
					responseMimeType: "application/json",
				},
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Gemini request failed: ${text}`);
		}

		const data = (await response.json()) as {
			candidates?: Array<{
				content?: {
					parts?: Array<{
						text?: string;
					}>;
				};
			}>;
		};

		const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
		if (!text) {
			throw new Error("Gemini returned an empty response");
		}
		return JSON.parse(text) as unknown;
	}
}
