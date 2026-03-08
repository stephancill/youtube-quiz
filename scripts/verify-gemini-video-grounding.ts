const videoId = process.argv[2] ?? "Y3tteHSrJlY";
const model = "gemini-2.5-flash";
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
	throw new Error("GEMINI_API_KEY is missing");
}

const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

const callGemini = async (
	parts: Array<Record<string, unknown>>,
	responseMimeType?: string,
) => {
	const response = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ role: "user", parts }],
				generationConfig: responseMimeType ? { responseMimeType } : undefined,
			}),
		},
	);

	if (!response.ok) {
		throw new Error(await response.text());
	}

	const data = (await response.json()) as {
		candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
	};

	const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
	if (!text) {
		throw new Error("Gemini returned empty text");
	}

	return text;
};

const quizPrompt = `Generate exactly 3 free-response quiz questions from the actual video content.
Each question object must include:
- prompt
- correctAnswer
- sourceTimestamp (MM:SS)

Do not base questions only on title metadata.
Return strict JSON:
{"questions":[{"prompt":"...","correctAnswer":"...","sourceTimestamp":"MM:SS"}]}`;

const quizRaw = await callGemini(
	[{ text: quizPrompt }, { file_data: { file_uri: videoUrl } }],
	"application/json",
);

const quiz = JSON.parse(quizRaw) as {
	questions?: Array<{
		prompt?: string;
		correctAnswer?: string;
		sourceTimestamp?: string;
	}>;
};

const questions = (quiz.questions ?? []).slice(0, 3).map((q) => ({
	prompt: q.prompt ?? "",
	correctAnswer: q.correctAnswer ?? "",
	sourceTimestamp: q.sourceTimestamp ?? "00:00",
}));

const results: Array<{
	question: string;
	correctAnswer: string;
	sourceTimestamp: string;
	modelAnswer: string;
	graderVerdict: "PASS" | "FAIL";
	graderFeedback: string;
}> = [];

for (const question of questions) {
	const modelAnswer = await callGemini([
		{
			text: `Answer this question from the video in one short sentence: ${question.prompt}`,
		},
		{ file_data: { file_uri: videoUrl } },
	]);

	const gradePrompt = `You are grading semantic equivalence.
Question: ${question.prompt}
Expected answer: ${question.correctAnswer}
Candidate answer: ${modelAnswer}

Return strict JSON:
{"pass":true,"feedback":"..."}`;

	const gradeRaw = await callGemini(
		[{ text: gradePrompt }],
		"application/json",
	);
	const grade = JSON.parse(gradeRaw) as { pass?: boolean; feedback?: string };

	results.push({
		question: question.prompt,
		correctAnswer: question.correctAnswer,
		sourceTimestamp: question.sourceTimestamp,
		modelAnswer,
		graderVerdict: grade.pass ? "PASS" : "FAIL",
		graderFeedback: grade.feedback ?? "",
	});
}

const passCount = results.filter((r) => r.graderVerdict === "PASS").length;

console.log(
	JSON.stringify(
		{
			videoId,
			videoUrl,
			questionCount: questions.length,
			passCount,
			results,
		},
		null,
		2,
	),
);
