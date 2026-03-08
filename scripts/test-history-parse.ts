const htmlPath = process.argv[2];

if (!htmlPath) {
	console.error("Usage: bun scripts/test-history-parse.ts <history.html>");
	process.exit(1);
}

const html = await Bun.file(htmlPath).text();

const match =
	html.match(/var ytInitialData = (\{[\s\S]*?\});<\/script>/) ??
	html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});/);

if (!match?.[1]) {
	console.error("Could not locate ytInitialData in HTML");
	process.exit(1);
}

const data = JSON.parse(match[1]) as unknown;
const stack: unknown[] = [data];
const seen = new Set<string>();

const longVideos: Array<{
	videoId: string;
	title: string;
	duration: string;
}> = [];

const parseDurationSeconds = (value: string | null): number => {
	if (!value) {
		return 0;
	}
	const parts = value.split(":").map((part) => Number.parseInt(part, 10));
	if (parts.some((part) => Number.isNaN(part))) {
		return 0;
	}
	if (parts.length === 2) {
		const [minutes = 0, seconds = 0] = parts;
		return minutes * 60 + seconds;
	}
	if (parts.length === 3) {
		const [hours = 0, minutes = 0, seconds = 0] = parts;
		return hours * 3600 + minutes * 60 + seconds;
	}
	return 0;
};

while (stack.length > 0) {
	const current = stack.pop();
	if (!current || typeof current !== "object") {
		continue;
	}

	const maybeRenderer = current as { videoRenderer?: unknown };
	if (
		maybeRenderer.videoRenderer &&
		typeof maybeRenderer.videoRenderer === "object"
	) {
		const video = maybeRenderer.videoRenderer as {
			videoId?: unknown;
			title?: { runs?: Array<{ text?: unknown }> };
			lengthText?: { simpleText?: unknown };
		};

		const videoId = typeof video.videoId === "string" ? video.videoId : null;
		const title =
			typeof video.title?.runs?.[0]?.text === "string"
				? video.title.runs[0].text
				: null;
		const duration =
			typeof video.lengthText?.simpleText === "string"
				? video.lengthText.simpleText
				: null;

		if (videoId && title && duration && !seen.has(videoId)) {
			seen.add(videoId);
			if (parseDurationSeconds(duration) >= 300) {
				longVideos.push({ videoId, title, duration });
			}
		}
	}

	for (const value of Object.values(current)) {
		stack.push(value);
	}
}

console.log(
	JSON.stringify(
		{
			totalLongVideos: longVideos.length,
			sample: longVideos.slice(0, 10),
			note: "Shorts are excluded because they do not have a >= 5:00 lengthText",
		},
		null,
		2,
	),
);
