import { createSign } from "node:crypto";
import http2 from "node:http2";
import { config } from "./config";

type ApnsPayload = {
	title: string;
	body: string;
	badge?: number;
};

let cachedJwt: { token: string; expiresAt: number } | null = null;

export function isApnsConfigured(): boolean {
	return Boolean(
		config.APNS_KEY_ID && config.APNS_TEAM_ID && config.APNS_PRIVATE_KEY,
	);
}

export async function sendApnsNotification(input: {
	deviceToken: string;
	payload: ApnsPayload;
}) {
	if (!isApnsConfigured()) {
		console.warn("[apns] skipped=missing_configuration");
		return;
	}

	const jwt = await getApnsJwt();
	const host =
		config.APNS_ENVIRONMENT === "production"
			? "https://api.push.apple.com"
			: "https://api.sandbox.push.apple.com";
	const body = JSON.stringify({
		aps: {
			alert: {
				title: input.payload.title,
				body: input.payload.body,
			},
			...(input.payload.badge === undefined
				? {}
				: { badge: input.payload.badge }),
			sound: "default",
		},
	});

	await new Promise<void>((resolve, reject) => {
		const client = http2.connect(host);
		client.on("error", reject);

		const request = client.request({
			":method": "POST",
			":path": `/3/device/${input.deviceToken}`,
			authorization: `bearer ${jwt}`,
			"apns-topic": config.APNS_BUNDLE_ID,
			"apns-push-type": "alert",
			"content-type": "application/json",
		});
		let responseBody = "";
		let status = 0;

		request.setEncoding("utf8");
		request.on("data", (chunk) => {
			responseBody += chunk;
		});
		request.on("response", (headers) => {
			status = Number(headers[":status"]);
		});
		request.on("error", (error) => {
			client.close();
			reject(error);
		});
		request.on("end", () => {
			client.close();
			if (status >= 200 && status < 300) {
				resolve();
				return;
			}

			reject(new Error(`APNs request failed with ${status}: ${responseBody}`));
		});
		request.end(body);
	});
}

async function getApnsJwt(): Promise<string> {
	const nowSeconds = Math.floor(Date.now() / 1000);
	if (cachedJwt && cachedJwt.expiresAt > nowSeconds + 60) {
		return cachedJwt.token;
	}

	const header = base64UrlJson({ alg: "ES256", kid: config.APNS_KEY_ID });
	const claims = base64UrlJson({ iss: config.APNS_TEAM_ID, iat: nowSeconds });
	const signingInput = `${header}.${claims}`;
	const signature = await signApnsJwt(signingInput);
	const token = `${signingInput}.${signature}`;
	cachedJwt = { token, expiresAt: nowSeconds + 50 * 60 };
	return token;
}

async function signApnsJwt(signingInput: string): Promise<string> {
	if (!config.APNS_PRIVATE_KEY) {
		throw new Error("APNS_PRIVATE_KEY is required");
	}

	const derSignature = createSign("SHA256")
		.update(signingInput)
		.sign(config.APNS_PRIVATE_KEY.replaceAll("\\n", "\n"));
	return derSignatureToJose(derSignature);
}

function derSignatureToJose(signature: Buffer): string {
	let offset = 0;
	if (signature[offset] !== 0x30) {
		throw new Error("Invalid APNs JWT DER signature sequence");
	}
	offset += 1;
	({ offset } = readDerLength(signature, offset));

	if (signature[offset] !== 0x02) {
		throw new Error("Invalid APNs JWT DER r value");
	}
	offset += 1;
	const rLengthResult = readDerLength(signature, offset);
	const rLength = rLengthResult.length;
	offset = rLengthResult.offset;
	const r = signature.subarray(offset, offset + rLength);
	offset += rLength;

	if (signature[offset] !== 0x02) {
		throw new Error("Invalid APNs JWT DER s value");
	}
	offset += 1;
	const sLengthResult = readDerLength(signature, offset);
	const sLength = sLengthResult.length;
	offset = sLengthResult.offset;
	const s = signature.subarray(offset, offset + sLength);

	return Buffer.concat([
		normalizeJoseInteger(r),
		normalizeJoseInteger(s),
	]).toString("base64url");
}

function readDerLength(
	buffer: Buffer,
	offset: number,
): {
	length: number;
	offset: number;
} {
	let length = buffer[offset] ?? 0;
	offset += 1;
	if (length < 0x80) {
		return { length, offset };
	}

	const byteCount = length & 0x7f;
	length = 0;
	for (let index = 0; index < byteCount; index += 1) {
		length = (length << 8) | (buffer[offset] ?? 0);
		offset += 1;
	}
	return { length, offset };
}

function normalizeJoseInteger(value: Buffer): Buffer {
	let normalized = value;
	while (normalized.length > 32 && normalized[0] === 0) {
		normalized = normalized.subarray(1);
	}
	if (normalized.length < 32) {
		return Buffer.concat([Buffer.alloc(32 - normalized.length), normalized]);
	}
	if (normalized.length !== 32) {
		throw new Error("Invalid APNs JWT integer size");
	}
	return normalized;
}

function base64UrlJson(value: unknown): string {
	return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
}
