import { existsSync } from "node:fs";
import path from "node:path";
import { error } from "@sveltejs/kit";
import { requireMediaAccess } from "$lib/server/api-guard";
import { mediaDb } from "$lib/server/db";
import { getPlaybackPlan } from "$lib/server/hls";
import { getMediaProgressSnapshot } from "$lib/server/media-progress";
import { createMediaToken } from "$lib/server/media-token";
import { getSubtitleTracksForMedia } from "$lib/server/subtitles";
import type { PageServerLoad } from "./$types";

/** How the browser plays this item: the file as is, the live HLS conversion, or the torrent while it downloads. */
async function getPlayback(mediaItem: { id: string; filePath: string | null }, origin: string) {
	const stream = { mode: "stream" as const, src: `/api/media/${mediaItem.id}/stream`, externalUrl: null };
	if (!(mediaItem.filePath && existsSync(mediaItem.filePath))) {
		return stream;
	}
	const fileName = encodeURIComponent(path.basename(mediaItem.filePath));
	const externalUrl = `${origin}/media-file/${mediaItem.id}/${fileName}?token=${createMediaToken(mediaItem.id)}`;
	try {
		const plan = await getPlaybackPlan(mediaItem.filePath);
		if (plan.mode === "hls") {
			return { mode: "hls" as const, src: `/api/media/${mediaItem.id}/hls/index.m3u8`, externalUrl };
		}
	} catch (errorValue) {
		console.error("[Watch] Failed to probe media, trying direct playback:", errorValue);
	}
	return { ...stream, mode: "direct" as const, externalUrl };
}

export const load: PageServerLoad = async ({ depends, params, locals, url }) => {
	const { mediaItem, organizationId } = requireMediaAccess(locals, params.id);
	if (mediaItem.type === "show") {
		throw error(400, "Shows are not directly watchable");
	}
	depends(`/api/media/${params.id}`);
	const nextEpisode = mediaItem.type === "episode" ? mediaDb.getNextEpisodeById(mediaItem.id) : null;

	return {
		media: mediaItem,
		progress: getMediaProgressSnapshot(params.id, organizationId),
		nextEpisode: nextEpisode
			? {
					id: nextEpisode.id,
					title: nextEpisode.title,
					seasonNumber: nextEpisode.seasonNumber,
					episodeNumber: nextEpisode.episodeNumber,
					stillPath: nextEpisode.stillPath,
					backdropUrl: nextEpisode.backdropUrl,
					posterUrl: nextEpisode.posterUrl,
				}
			: null,
		subtitleTracks: await getSubtitleTracksForMedia(mediaItem),
		playback: await getPlayback(mediaItem, url.origin),
	};
};
