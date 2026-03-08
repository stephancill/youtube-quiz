import { z } from "zod";

const envSchema = z.object({
	TELEGRAM_BOT_TOKEN: z.string().min(1),
	GEMINI_API_KEY: z.string().min(1),
	POLL_INTERVAL_MINUTES: z
		.string()
		.default("30")
		.transform((value) => Number.parseInt(value, 10)),
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
	throw new Error(`Invalid environment configuration:\n${details}`);
}

export const config = parsedEnv.data;
