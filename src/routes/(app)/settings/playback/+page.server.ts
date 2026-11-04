import { fail } from "@sveltejs/kit";
import { detectEncoders, ENCODER_IDS, ENCODER_LABELS, isEncoderSetting } from "$lib/server/encoder";
import { getSettings, isTorrentEngine, updateSettings } from "$lib/server/settings";
import { isOwner } from "$lib/server/settings-guard";
import { requireSection } from "../sections";
import type { Actions, PageServerLoad } from "./$types";

const SECTION_HREF = "/settings/playback";

export const load: PageServerLoad = async ({ parent }) => {
	const { userRole } = await parent();
	requireSection(userRole, SECTION_HREF);
	const [settings, report] = await Promise.all([getSettings(), detectEncoders()]);

	return {
		encoder: settings.playback.encoder,
		engine: settings.downloads.engine,
		rqbitUrl: settings.downloads.rqbitUrl,
		encoders: ENCODER_IDS.map((id) => ({
			value: id,
			label: ENCODER_LABELS[id],
			working: id === "auto" || report.working.includes(id),
		})),
		report,
	};
};

export const actions: Actions = {
	save: async (event) => {
		if (!(await isOwner(event))) {
			return fail(403, { error: "Only owners can change playback settings" });
		}
		const form = await event.request.formData();
		const encoder = form.get("encoder")?.toString();
		const engine = form.get("engine")?.toString();
		const rqbitUrl = form.get("rqbitUrl")?.toString().trim() ?? "";
		if (!(isEncoderSetting(encoder) && isTorrentEngine(engine))) {
			return fail(400, { error: "Unknown encoder or download engine" });
		}
		if (rqbitUrl && !URL.canParse(rqbitUrl)) {
			return fail(400, { error: "rqbit URL is not a valid URL" });
		}
		await updateSettings({ videoEncoder: encoder, torrentEngine: engine, rqbitUrl });
		return { success: true };
	},

	detect: async (event) => {
		if (!(await isOwner(event))) {
			return fail(403, { error: "Only owners can run detection" });
		}
		await detectEncoders(true);
		return { success: true };
	},

	testRqbit: async (event) => {
		if (!(await isOwner(event))) {
			return fail(403, { error: "Only owners can test the engine" });
		}
		const url = (await event.request.formData()).get("rqbitUrl")?.toString().trim() ?? "";
		if (!URL.canParse(url)) {
			return fail(400, { error: "rqbit URL is not a valid URL" });
		}
		try {
			const response = await fetch(new URL("/torrents", url), { signal: AbortSignal.timeout(5000) });
			if (!response.ok) {
				return fail(502, { error: `rqbit answered ${response.status}` });
			}
		} catch {
			return fail(502, { error: "Could not reach rqbit at that URL" });
		}
		return { success: true, rqbitReachable: true };
	},
};
