import { config } from "./config";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys";
const MAX_KEYS_CACHE_AGE_MS = 60 * 60 * 1000;

type AppleJwk = {
	kty: string;
	kid: string;
	alg: string;
	use?: string;
	n: string;
	e: string;
};

type AppleKeysResponse = {
	keys: AppleJwk[];
};

export type VerifiedAppleIdentity = {
	subject: string;
	email: string | null;
};

let cachedKeys: { keys: AppleJwk[]; fetchedAt: number } | null = null;

export async function verifyAppleIdentityToken(
	identityToken: string,
): Promise<VerifiedAppleIdentity> {
	const tokenParts = identityToken.split(".");
	if (tokenParts.length !== 3) {
		throw new Error("invalid Apple identity token");
	}

	const [encodedHeader, encodedPayload, encodedSignature] = tokenParts as [
		string,
		string,
		string,
	];
	const header = decodeBase64UrlJson(encodedHeader) as {
		alg?: string;
		kid?: string;
	};
	const payload = decodeBase64UrlJson(encodedPayload) as {
		iss?: string;
		aud?: string;
		exp?: number;
		sub?: string;
		email?: string;
	};

	if (header.alg !== "RS256" || !header.kid) {
		throw new Error("unsupported Apple identity token algorithm");
	}
	if (payload.iss !== APPLE_ISSUER) {
		throw new Error("invalid Apple identity token issuer");
	}
	if (payload.aud !== config.APPLE_CLIENT_ID) {
		throw new Error("invalid Apple identity token audience");
	}
	if (!payload.exp || payload.exp * 1000 <= Date.now()) {
		throw new Error("expired Apple identity token");
	}
	if (!payload.sub) {
		throw new Error("missing Apple subject");
	}

	const jwk = await findAppleKey(header.kid);
	const key = await crypto.subtle.importKey(
		"jwk",
		jwk as never,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	const signature = decodeBase64UrlBuffer(encodedSignature);
	const signedPayload = new TextEncoder().encode(
		`${encodedHeader}.${encodedPayload}`,
	).buffer as ArrayBuffer;
	const verified = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		signature,
		signedPayload,
	);
	if (!verified) {
		throw new Error("invalid Apple identity token signature");
	}

	return {
		subject: payload.sub,
		email: payload.email ?? null,
	};
}

async function findAppleKey(kid: string): Promise<AppleJwk> {
	const keys = await getAppleKeys();
	const jwk = keys.find((key) => key.kid === kid);
	if (!jwk) {
		cachedKeys = null;
		const refreshedKeys = await getAppleKeys();
		const refreshedJwk = refreshedKeys.find((key) => key.kid === kid);
		if (!refreshedJwk) {
			throw new Error("Apple signing key not found");
		}
		return refreshedJwk;
	}
	return jwk;
}

async function getAppleKeys(): Promise<AppleJwk[]> {
	if (cachedKeys && Date.now() - cachedKeys.fetchedAt < MAX_KEYS_CACHE_AGE_MS) {
		return cachedKeys.keys;
	}

	const response = await fetch(APPLE_KEYS_URL);
	if (!response.ok) {
		throw new Error(`Apple keys request failed with ${response.status}`);
	}
	const body = (await response.json()) as AppleKeysResponse;
	cachedKeys = { keys: body.keys, fetchedAt: Date.now() };
	return body.keys;
}

function decodeBase64UrlJson(value: string): unknown {
	return JSON.parse(new TextDecoder().decode(decodeBase64UrlBuffer(value)));
}

function decodeBase64UrlBuffer(value: string): ArrayBuffer {
	const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = normalized.padEnd(
		normalized.length + ((4 - (normalized.length % 4)) % 4),
		"=",
	);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer as ArrayBuffer;
}
