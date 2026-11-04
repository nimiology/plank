// The original library file for external players (VLC, Infuse). They cannot send the session
// cookie, so the link carries a signed, expiring token instead. Lives outside /api, which requires a session.

import { existsSync } from "node:fs";
import { error } from "@sveltejs/kit";
import { mediaDb } from "$lib/server/db";
import { serveFile } from "$lib/server/file-response";
import { verifyMediaToken } from "$lib/server/media-token";
import type { RequestHandler } from "./$types";

function resolveFile(id: string, token: string | null): string {
	if (!verifyMediaToken(id, token)) {
		throw error(403, "Link expired or invalid");
	}
	const filePath = mediaDb.getById(id)?.filePath;
	if (!(filePath && existsSync(filePath))) {
		throw error(404, "Media is not in the library");
	}
	return filePath;
}

export const GET: RequestHandler = ({ params, url, request }) =>
	serveFile(resolveFile(params.id, url.searchParams.get("token")), request.headers.get("range"));

export const HEAD: RequestHandler = ({ params, url }) => {
	const response = serveFile(resolveFile(params.id, url.searchParams.get("token")), null);
	response.body?.cancel();
	return new Response(null, { status: 200, headers: response.headers });
};
