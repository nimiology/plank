import { error } from "@sveltejs/kit";
import { requireOrganizationAccess } from "$lib/server/api-guard";
import { getSettings } from "$lib/server/settings";
import type { RequestHandler } from "./$types";

const SIZES = new Set(["w300", "w342", "w780"]);
const FILE_REGEX = /^[A-Za-z0-9]+\.(jpg|png)$/;

/** Fetch a TMDB image server-side (through the server's proxy) for viewers who can't reach image.tmdb.org. */
export const GET: RequestHandler = async ({ params, locals }) => {
	requireOrganizationAccess(locals);
	if (!(SIZES.has(params.size) && FILE_REGEX.test(params.file))) {
		throw error(400, "Invalid image");
	}

	const settings = await getSettings();
	const res = await fetch(`${settings.tmdb.imageBaseUrl}/${params.size}/${params.file}`);
	if (!res.ok) {
		throw error(res.status === 404 ? 404 : 502, "Image unavailable");
	}
	return new Response(res.body, {
		headers: {
			"Content-Type": res.headers.get("content-type") ?? "image/jpeg",
			// TMDB image paths are content-addressed, so they never change
			"Cache-Control": "private, max-age=604800, immutable",
		},
	});
};
