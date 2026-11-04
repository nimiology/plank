// Resolves IMDb-based torrents and starts shared movie or episode downloads
// FEATURE: Metadata-first episodic torrent acquisition for queued season ingestion flows

import { downloadsDb, mediaDb } from "./db";
import { type FindBestTorrentOptions, findBestTorrent } from "./prowlarr";
import { startDownload } from "./torrent/download";
import { getDownloadStatus } from "./torrent/status";
import { cacheTorrent, getCachedTorrent } from "./torrent-cache";

export interface AcquireMediaOptions {
	mediaType?: "movie" | "episode";
	seasonNumber?: number | null;
	episodeNumber?: number | null;
}

export interface AcquireMediaResult {
	status: "started" | "active" | "complete" | "not_found" | "error";
	mediaId: string;
}

function getMediaLogLabel(mediaId: string): string {
	const mediaItem = mediaDb.getById(mediaId);
	if (!mediaItem) {
		return mediaId;
	}
	if (mediaItem.type !== "episode") {
		return mediaItem.title;
	}
	const show = mediaItem.parentId ? mediaDb.getById(mediaItem.parentId) : null;
	const seasonNumber = String(mediaItem.seasonNumber ?? 0).padStart(2, "0");
	const episodeNumber = String(mediaItem.episodeNumber ?? 0).padStart(2, "0");
	return `${show?.title ?? "Unknown Show"} S${seasonNumber}E${episodeNumber} ${mediaItem.title}`;
}

function getSearchOptions(mediaId: string, options?: AcquireMediaOptions): FindBestTorrentOptions | undefined {
	const mediaItem = mediaDb.getById(mediaId);
	const show = mediaItem?.parentId ? mediaDb.getById(mediaItem.parentId) : null;
	if (!mediaItem || mediaItem.type !== "episode") {
		if (options?.mediaType === "episode" && options.seasonNumber && options.episodeNumber) {
			return {
				mediaType: "episode",
				seasonNumber: options.seasonNumber,
				episodeNumber: options.episodeNumber,
				showTitle: show?.title,
				episodeTitle: mediaItem?.title,
				year: show?.year,
			};
		}
		return mediaItem?.type === "movie" ? { mediaType: "movie", title: mediaItem.title, year: mediaItem.year } : undefined;
	}
	if (!(mediaItem.seasonNumber && mediaItem.episodeNumber)) {
		return undefined;
	}
	return {
		mediaType: "episode",
		seasonNumber: options?.seasonNumber ?? mediaItem.seasonNumber,
		episodeNumber: options?.episodeNumber ?? mediaItem.episodeNumber,
		showTitle: show?.title,
		episodeTitle: mediaItem.title,
		year: show?.year,
	};
}

async function createDownloadIfNeeded(mediaId: string, magnetLink: string, infohash: string): Promise<void> {
	const existingDownload = downloadsDb.getByInfohash(mediaId, infohash);
	if (existingDownload) {
		return;
	}
	downloadsDb.create({
		mediaId,
		magnetLink,
		infohash,
		status: "added",
		progress: 0,
	});
}

async function startAttachedDownload(
	mediaId: string,
	magnetLink: string,
	infohash: string
): Promise<AcquireMediaResult> {
	const mediaLabel = getMediaLogLabel(mediaId);
	mediaDb.update(mediaId, {
		magnetLink,
		infohash,
	});
	await createDownloadIfNeeded(mediaId, magnetLink, infohash);
	try {
		console.log(`[Acquire] Starting download for ${mediaLabel}`);
		await startDownload(mediaId, magnetLink);
		return { status: "started", mediaId };
	} catch (errorValue) {
		console.error(`[Acquire] Failed to start download for ${mediaId}:`, errorValue);
		mediaDb.updateProgress(mediaId, 0, "error");
		const download = downloadsDb.getByInfohash(mediaId, infohash);
		if (download) {
			downloadsDb.updateProgress(download.id, 0, "error");
		}
		return { status: "error", mediaId };
	}
}

export async function acquireMediaByImdb(mediaId: string, options?: AcquireMediaOptions): Promise<AcquireMediaResult> {
	const mediaItem = mediaDb.getById(mediaId);
	const mediaLabel = getMediaLogLabel(mediaId);
	if (!(mediaItem && mediaItem.type !== "show")) {
		return { status: "error", mediaId };
	}
	if (mediaItem.filePath || mediaItem.status === "complete") {
		return { status: "complete", mediaId };
	}
	const activeStatus = getDownloadStatus(mediaId);
	if (activeStatus && activeStatus.status !== "error" && activeStatus.status !== "complete") {
		return { status: "active", mediaId };
	}
	if (mediaItem.magnetLink && mediaItem.infohash) {
		return startAttachedDownload(mediaId, mediaItem.magnetLink, mediaItem.infohash);
	}
	if (!mediaItem.imdbId) {
		console.log(`[Acquire] No IMDb id for ${mediaLabel}, marking as not found`);
		mediaDb.updateProgress(mediaId, 0, "not_found");
		return { status: "not_found", mediaId };
	}
	console.log(`[Acquire] Searching Prowlarr for ${mediaLabel}`);
	mediaDb.update(mediaId, { status: "searching", progress: 0 });
	const cachedTorrent = await getCachedTorrent(mediaItem.imdbId);
	if (cachedTorrent) {
		console.log(`[Acquire] Using cached torrent for ${mediaLabel}`);
		return startAttachedDownload(mediaId, cachedTorrent.magnetLink, cachedTorrent.infohash);
	}
	const result = await findBestTorrent(mediaItem.imdbId, getSearchOptions(mediaId, options));
	if (!result) {
		console.log(`[Acquire] No torrent found for ${mediaLabel}`);
		mediaDb.updateProgress(mediaId, 0, "not_found");
		return { status: "not_found", mediaId };
	}
	console.log(`[Acquire] Found torrent for ${mediaLabel}: ${result.title}`);
	await cacheTorrent({
		imdbId: mediaItem.imdbId,
		magnetLink: result.magnetUri,
		infohash: result.infohash,
	});
	return startAttachedDownload(mediaId, result.magnetUri, result.infohash);
}

export async function waitForTerminalMediaState(
	mediaId: string
): Promise<"complete" | "error" | "not_found" | "removed"> {
	while (true) {
		const mediaItem = mediaDb.getById(mediaId);
		if (!mediaItem) {
			return "error";
		}
		if (
			mediaItem.status === "complete" ||
			mediaItem.status === "error" ||
			mediaItem.status === "not_found" ||
			mediaItem.status === "removed"
		) {
			return mediaItem.status;
		}
		const downloadStatus = getDownloadStatus(mediaId);
		if (downloadStatus?.status === "complete") {
			return "complete";
		}
		if (downloadStatus?.status === "error") {
			mediaDb.updateProgress(mediaId, 0, "error");
			return "error";
		}
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
}
