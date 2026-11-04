import { fail, type RequestEvent } from "@sveltejs/kit";
import { getSettings, updateSettings } from "$lib/server/settings";
import { isOwner } from "$lib/server/settings-guard";
import { requireSection } from "../sections";
import type { Actions, PageServerLoad } from "./$types";

const SECTION_HREF = "/settings/connections";
const DEFAULT_MIN_SEEDERS = 5;

type ConnectionUpdate = Parameters<typeof updateSettings>[0];

export const load: PageServerLoad = async ({ parent }) => {
	const { userRole } = await parent();
	requireSection(userRole, SECTION_HREF);
	const settings = await getSettings();

	return {
		settings: {
			tmdb: { apiKey: settings.tmdb.apiKey },
			prowlarr: {
				url: settings.prowlarr.url,
				apiKey: settings.prowlarr.apiKey,
				minSeeders: settings.prowlarr.minSeeders,
			},
			opensubtitles: settings.opensubtitles,
		},
	};
};

/** Save one connection. Fields the form does not send stay unchanged. */
async function saveConnection(
	event: RequestEvent,
	build: (formData: FormData) => ConnectionUpdate
): Promise<{ success: true } | ReturnType<typeof fail>> {
	if (!(await isOwner(event))) {
		return fail(403, { error: "Only owners can change connections" });
	}

	const formData = await event.request.formData();

	try {
		await updateSettings(build(formData));
	} catch (err) {
		console.error("Failed to update connection:", err);
		return fail(500, { error: "Failed to save the connection" });
	}

	return { success: true };
}

function parseMinSeeders(value: string | undefined): number {
	const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
	if (Number.isNaN(parsed) || parsed < 0) {
		return DEFAULT_MIN_SEEDERS;
	}
	return parsed;
}

export const actions: Actions = {
	tmdb: (event) =>
		saveConnection(event, (formData) => ({
			tmdbApiKey: formData.get("tmdbApiKey")?.toString() || "",
		})),

	opensubtitles: (event) =>
		saveConnection(event, (formData) => ({
			opensubtitlesApiKey: formData.get("opensubtitlesApiKey")?.toString() || "",
			opensubtitlesUsername: formData.get("opensubtitlesUsername")?.toString() || "",
			opensubtitlesPassword: formData.get("opensubtitlesPassword")?.toString() || "",
		})),

	prowlarr: (event) =>
		saveConnection(event, (formData) => ({
			prowlarrUrl: formData.get("prowlarrUrl")?.toString() || "",
			prowlarrApiKey: formData.get("prowlarrApiKey")?.toString() || "",
			prowlarrMinSeeders: parseMinSeeders(formData.get("prowlarrMinSeeders")?.toString()),
		})),
};
