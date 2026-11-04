/**
 * Torrent Resolution API
 *
 * Resolves IMDB ID to a magnet link via Prowlarr.
 * Filters for high-quality releases from trusted groups.
 */

import { error, json } from "@sveltejs/kit";
import { findBestTorrent } from "$lib/server/prowlarr";
import { getBrowseItemDetails } from "$lib/server/tmdb";
import { cacheTorrent, getCachedTorrent } from "$lib/server/torrent-cache";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		throw error(401, "Unauthorized");
	}

	const body = await request.json();
	const { imdbId, tmdbId, title, year } = body;

	if (!(imdbId || tmdbId)) {
		throw error(400, "Either imdbId or tmdbId is required");
	}

	// Get IMDB ID if only TMDB ID provided
	let resolvedImdbId = imdbId;
	if (!resolvedImdbId && tmdbId) {
		// Assume movie type for resolve API (can be extended to support TV)
		const details = await getBrowseItemDetails(tmdbId, "movie");
		resolvedImdbId = details.imdbId;
	}

	if (!resolvedImdbId) {
		throw error(400, "Could not resolve IMDB ID for this movie");
	}

	// Check cache first
	const cached = await getCachedTorrent(resolvedImdbId);
	if (cached) {
		return json({
			success: true,
			torrent: { magnetLink: cached.magnetLink },
		});
	}

	// Search Prowlarr for best torrent
	const torrent = await findBestTorrent(resolvedImdbId, {
		mediaType: "movie",
		title: typeof title === "string" ? title : undefined,
		year: typeof year === "number" ? year : null,
	});

	if (!torrent) {
		return json({
			success: false,
			error: "No suitable torrent found",
			message: "Could not find a high-quality torrent from trusted sources",
		});
	}

	// Cache the result
	await cacheTorrent({
		imdbId: resolvedImdbId,
		magnetLink: torrent.magnetUri,
		infohash: torrent.infohash,
	});

	return json({
		success: true,
		torrent: { magnetLink: torrent.magnetUri },
	});
};
