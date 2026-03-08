export type QuizQuestion = {
	prompt: string;
	correctAnswer: string;
	sourceTimestamp: string;
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

export type LinkedUser = {
	telegramUserId: number;
	chatId: number;
	youtubeCookieHeader: string;
	lastPolledPublishedAt: string | null;
};
