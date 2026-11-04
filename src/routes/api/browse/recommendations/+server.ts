import { json } from "@sveltejs/kit";
import { requireOrganizationAccess } from "$lib/server/api-guard";
import { getForYouRows } from "$lib/server/recommendations";
import type { RequestHandler } from "./$types";

/** The profile's "for you" rows for the browse page. */
export const GET: RequestHandler = async ({ locals }) => {
	const { organizationId } = requireOrganizationAccess(locals);
	return json({ rows: await getForYouRows(organizationId) });
};
