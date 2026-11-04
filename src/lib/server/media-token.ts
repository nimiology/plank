// Signed links to a media file, for players such as VLC and Infuse that cannot send the session cookie.

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "$env/dynamic/private";

const LINK_LIFETIME_MS = 12 * 60 * 60 * 1000;

function sign(mediaId: string, expiresAt: number): string {
	const secret = env.BETTER_AUTH_SECRET;
	if (!secret) {
		throw new Error("BETTER_AUTH_SECRET is not set; cannot sign media links");
	}
	return createHmac("sha256", secret).update(`media-file:${mediaId}:${expiresAt}`).digest("base64url");
}

export function createMediaToken(mediaId: string, now = Date.now()): string {
	const expiresAt = now + LINK_LIFETIME_MS;
	return `${expiresAt}.${sign(mediaId, expiresAt)}`;
}

export function verifyMediaToken(mediaId: string, token: string | null, now = Date.now()): boolean {
	const [expiresText, signature] = (token ?? "").split(".");
	const expiresAt = Number.parseInt(expiresText ?? "", 10);
	if (!(signature && Number.isFinite(expiresAt)) || expiresAt < now) {
		return false;
	}
	const expected = Buffer.from(sign(mediaId, expiresAt));
	const given = Buffer.from(signature);
	return expected.length === given.length && timingSafeEqual(expected, given);
}
