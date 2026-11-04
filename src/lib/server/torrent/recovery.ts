import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { mediaDb } from "../db";
import { isSupportedFormat } from "../ffmpeg";
import {
	buildMovieFileName,
	getEpisodeLibraryPath,
	getMovieLibraryRoot,
	getSeasonLibraryDirectory,
	PATHS,
} from "../paths";
import { finalizeMediaToLibrary } from "../transcoder";
import { startDownload } from "./download";
import { MIN_VIDEO_SIZE } from "./files";
import { isDownloadActive } from "./status";

async function finalizeFromTemp(mediaId: string, videoPath: string, fileName: string): Promise<boolean> {
	const mediaItem = mediaDb.getById(mediaId);
	if (!mediaItem) {
		return false;
	}
	let destDir = path.join(PATHS.library, mediaId);
	let destPath = path.join(destDir, fileName);
	if (mediaItem.type === "movie") {
		destDir = getMovieLibraryRoot(mediaItem);
		destPath = path.join(destDir, buildMovieFileName(mediaItem, fileName));
	} else if (mediaItem.type === "episode") {
		const show = mediaItem.parentId ? mediaDb.getById(mediaItem.parentId) : null;
		if (!(show && show.type === "show")) {
			return false;
		}
		destDir = getSeasonLibraryDirectory(show, mediaItem.seasonNumber);
		destPath = getEpisodeLibraryPath(show, mediaItem, fileName);
	}

	try {
		const finalized = await finalizeMediaToLibrary(videoPath, destPath);

		if (mediaItem.type === "episode") {
			mediaDb.updateFileInfo(mediaId, {
				fileIndex: mediaItem.fileIndex,
				filePath: finalized.filePath,
				fileSize: finalized.fileSize,
			});
		} else {
			mediaDb.updateFilePath(mediaId, finalized.filePath, finalized.fileSize);
		}

		mediaDb.updateProgress(mediaId, 1, "complete");

		try {
			await fs.rm(path.join(PATHS.temp, mediaId), { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors.
		}

		return true;
	} catch (e) {
		console.error(`[Recovery] [${mediaId}] Failed to finalize from temp:`, e);
		return false;
	}
}

async function findVideoInDirectory(dirPath: string): Promise<{ path: string; name: string; size: number } | null> {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		let bestVideo: { path: string; name: string; size: number } | null = null;

		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name);

			if (entry.isDirectory()) {
				const nested = await findVideoInDirectory(fullPath);
				if (nested && (!bestVideo || nested.size > bestVideo.size)) {
					bestVideo = nested;
				}
			} else if (entry.isFile() && isSupportedFormat(entry.name)) {
				const stats = await fs.stat(fullPath);
				if (!bestVideo || stats.size > bestVideo.size) {
					bestVideo = { path: fullPath, name: entry.name, size: stats.size };
				}
			}
		}

		return bestVideo;
	} catch {
		return null;
	}
}

async function recoverSingleMedia(mediaItem: {
	id: string;
	filePath: string | null;
	magnetLink: string | null;
	imdbId?: string | null;
}): Promise<void> {
	const mediaId = mediaItem.id;
	const tempDir = path.join(PATHS.temp, mediaId);

	if (isDownloadActive(mediaId)) {
		return;
	}

	if (mediaItem.filePath && existsSync(mediaItem.filePath)) {
		mediaDb.updateProgress(mediaId, 1, "complete");
		return;
	}

	// A file in temp may be half downloaded, and its size alone cannot tell. With a magnet link the
	// torrent engine re-checks the pieces on disk, resumes, and finalizes only once it is complete.
	if (!mediaItem.magnetLink && existsSync(tempDir)) {
		const videoInfo = await findVideoInDirectory(tempDir);
		if (videoInfo && videoInfo.size >= MIN_VIDEO_SIZE) {
			const success = await finalizeFromTemp(mediaId, videoInfo.path, videoInfo.name);
			if (success) {
				return;
			}
		}
	}

	if (mediaItem.magnetLink) {
		startDownload(mediaId, mediaItem.magnetLink).catch((e) => {
			console.error(`[Recovery] [${mediaId}] Failed to restart download:`, e);
			mediaDb.updateProgress(mediaId, 0, "error");
		});
	} else if (mediaItem.imdbId) {
		const { acquireMediaByImdb } = await import("../media-acquisition");
		const result = await acquireMediaByImdb(mediaId);
		if (result.status === "error") {
			mediaDb.updateProgress(mediaId, 0, "error");
		}
	} else {
		mediaDb.updateProgress(mediaId, 0, "not_found");
	}
}

export async function recoverDownloads(): Promise<void> {
	const incompleteMedia = mediaDb.getIncompleteDownloads();

	if (incompleteMedia.length === 0) {
		return;
	}

	for (const mediaItem of incompleteMedia) {
		await recoverSingleMedia(mediaItem);
	}
}
