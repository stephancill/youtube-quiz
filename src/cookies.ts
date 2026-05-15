import type { YoutubeCookieJar } from "./types";

export function parseYoutubeCookieJarFromHeader(
	input: string,
): YoutubeCookieJar {
	const normalized = input.trim();
	if (!normalized) {
		throw new Error("empty string");
	}

	const pairs = normalized
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);

	if (pairs.length === 0 || pairs.every((pair) => !pair.includes("="))) {
		throw new Error("missing key=value pairs");
	}

	const cookieJar: YoutubeCookieJar = {};

	for (const pair of pairs) {
		const separatorIndex = pair.indexOf("=");
		if (separatorIndex <= 0) {
			continue;
		}

		const cookieName = pair.slice(0, separatorIndex).trim();
		const cookieValue = pair.slice(separatorIndex + 1);
		if (!cookieName) {
			continue;
		}
		if (cookieName in cookieJar) {
			continue;
		}

		cookieJar[cookieName] = {
			value: cookieValue,
			expiresAt: null,
			domain: null,
			path: null,
			secure: false,
			httpOnly: false,
			sameSite: null,
		};
	}

	if (Object.keys(cookieJar).length === 0) {
		throw new Error("missing key=value pairs");
	}

	return cookieJar;
}
