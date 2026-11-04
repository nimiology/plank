import { error, json } from "@sveltejs/kit";
import { requireOrganizationAccess } from "$lib/server/api-guard";
import { getForYouRows, getMoreLikeThis } from "$lib/server/recommendations";
import type { RequestHandler } from "./$types";

/** No params: the profile's "for you" rows. ?tmdbId=&type=movie|show: "More like this" for one title. */
export const GET: RequestHandler = async ({ url, locals }) => {
	const { organizationId } = requireOrganizationAccess(locals);
	const tmdbId = url.searchParams.get("tmdbId");
	if (!tmdbId) {
		return json({ rows: await getForYouRows(organizationId) });
	}

	const id = Number.parseInt(tmdbId, 10);
	const type = url.searchParams.get("type");
	if (!Number.isInteger(id) || id <= 0 || (type !== "movie" && type !== "show")) {
		throw error(400, "Invalid tmdbId or type");
	}
	return json({ rows: [{ title: "More like this", items: await getMoreLikeThis(organizationId, id, type) }] });
};
