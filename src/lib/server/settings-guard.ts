import type { RequestEvent } from "@sveltejs/kit";
import { auth } from "$lib/server/auth";

/** Form actions run outside the layout load, so owner-only actions must check the role again. */
export async function isOwner(event: RequestEvent): Promise<boolean> {
	const organizationId = event.locals.session?.activeOrganizationId;
	if (!organizationId) {
		return false;
	}

	const permission = await auth.api
		.getActiveMemberRole({
			headers: event.request.headers,
			query: { organizationId },
		})
		.catch(() => null);

	return permission?.role === "owner";
}
