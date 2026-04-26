export type QuizQuestion = {
	prompt: string;
	correctAnswer: string;
	sourceTimestamp: string;
	hint?: string;
};

export type QuizPayload = {
	videoId: string;
	videoTitle: string;
	questions: QuizQuestion[];
};

export type GradeResult = {
	isCorrect: boolean;
	feedback: string;
};

export type YoutubeVideo = {
	id: string;
	title: string;
	channelTitle: string;
	publishedAt: string;
	watchedRatio: number;
};

export type YoutubeCookie = {
	value: string;
	expiresAt: string | null;
	domain: string | null;
	path: string | null;
	secure: boolean;
	httpOnly: boolean;
	sameSite: string | null;
};

export type YoutubeCookieJar = Record<string, YoutubeCookie>;

export type LinkedUser = {
	telegramUserId: number;
	chatId: number;
	youtubeCookieJar: YoutubeCookieJar;
	lastPolledPublishedAt: string | null;
};
