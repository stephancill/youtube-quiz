import { z } from "zod";

const envSchema = z.object({
	GEMINI_API_KEY: z.string().min(1),
	MIN_WATCH_RATIO: z
		.string()
		.default("0.75")
		.transform((value) => Number.parseFloat(value)),
	QUIZ_MAX_HISTORY_ITEMS: z
		.string()
		.default("8")
		.transform((value) => Number.parseInt(value, 10)),
	DATABASE_PATH: z.string().default("./data/app.db"),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
	const details = parsedEnv.error.issues
		.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
		.join("\n");
	throw new Error(`Invalid OpenClaw environment configuration:\n${details}`);
}

export const openclawConfig = parsedEnv.data;
