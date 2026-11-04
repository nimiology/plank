import { createReadStream, createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { mediaDb } from "./db";
import { normalizeFileForPlayback, probeFile, requiresBrowserSafePlayback } from "./ffmpeg";

const activeNormalizationJobs = new Map<string, Promise<string | null>>();

let activeLibraryScan: Promise<void> | null = null;

async function verifyFileIntegrity(filePath: string): Promise<boolean> {
	try {
		const stats = await fs.stat(filePath);
		if (stats.size === 0) {
			return false;
		}
		const probe = await probeFile(filePath);
		return Boolean((probe.videoCodec || probe.audioCodec) && (probe.duration ?? 0) > 0);
	} catch (error) {
		console.error(`[Transcoder] Integrity check failed for ${filePath}:`, error);
		return false;
	}
}

async function isDirectPlaybackReady(filePath: string): Promise<boolean> {
	if (path.extname(filePath).toLowerCase() !== ".mp4") {
		return false;
	}
	try {
		return !(await requiresBrowserSafePlayback(filePath));
	} catch (error) {
		console.error(`[Transcoder] Failed to verify direct playback for ${filePath}:`, error);
		return false;
	}
}

export async function transcodeLibrary(): Promise<void> {
	if (activeLibraryScan) {
		return activeLibraryScan;
	}

	activeLibraryScan = (async () => {
		await scanMovies();
		await scanShows();
	})();

	try {
		await activeLibraryScan;
	} finally {
		activeLibraryScan = null;
	}
}

async function scanMovies(): Promise<void> {
	const movies = mediaDb
		.getAll()
		.filter((media) => media.type === "movie" && media.filePath && existsSync(media.filePath));
	// Change to a job eventually
	for (const movie of movies) {
		await normalizeMediaForPlayback(movie.id);
	}
}

async function scanShows(): Promise<void> {
	const showIds = mediaDb
		.getAll()
		.filter((media) => media.type === "show")
		.map((media) => media.id);
	const episodes = showIds.flatMap((showId) => mediaDb.getEpisodesByParentId(showId));
	// Change to a job eventually
	for (const episode of episodes) {
		await normalizeMediaForPlayback(episode.id);
	}
}

export async function finalizeMediaToLibrary(
	sourcePath: string,
	targetPath: string,
	onProgress?: (progress: number) => void
): Promise<{ filePath: string; fileSize: number }> {
	onProgress?.(0);
	await fs.mkdir(path.dirname(targetPath), { recursive: true });

	// Check the download before moving it, so a broken file never replaces anything.
	if (!(await verifyFileIntegrity(sourcePath))) {
		throw new Error(`Downloaded file is invalid: ${sourcePath}`);
	}

	// The original file goes into the library as is; browsers get a converted stream at play time.
	try {
		await fs.rename(sourcePath, targetPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
			throw error;
		}
		await copyAcrossDevices(sourcePath, targetPath, onProgress);
	}

	const stats = await fs.stat(targetPath);
	onProgress?.(1);

	return { filePath: targetPath, fileSize: stats.size };
}

/** Copy through a temp name with progress, for when the temp and library folders are on different disks. */
async function copyAcrossDevices(
	sourcePath: string,
	targetPath: string,
	onProgress?: (progress: number) => void
): Promise<void> {
	const tempPath = `${targetPath}.partial`;
	const { size } = await fs.stat(sourcePath);
	let copied = 0;
	const reader = createReadStream(sourcePath);
	reader.on("data", (chunk) => {
		copied += chunk.length;
		onProgress?.(size > 0 ? Math.min(0.99, copied / size) : 0);
	});
	try {
		await pipeline(reader, createWriteStream(tempPath));
		await fs.rename(tempPath, targetPath);
	} catch (error) {
		await fs.unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

async function normalizeMediaForPlayback(mediaId: string): Promise<string | null> {
	const existingJob = activeNormalizationJobs.get(mediaId);

	if (existingJob) {
		return existingJob;
	}

	const job = (async () => {
		const media = mediaDb.getById(mediaId);
		if (!(media?.filePath && existsSync(media.filePath))) {
			return media?.filePath ?? null;
		}
		if (!(await shouldNormalizeFile(media.filePath))) {
			return media.filePath;
		}
		console.log(`[Transcoder] Normalizing ${media.type} ${mediaId}: ${media.filePath}`);
		await safeNormalize(media.filePath, (newPath, newSize) => {
			if (media.type === "episode") {
				mediaDb.updateFileInfo(media.id, {
					fileIndex: media.fileIndex,
					filePath: newPath,
					fileSize: newSize,
				});
				return;
			}
			mediaDb.updateFilePath(media.id, newPath, newSize);
		});
		return mediaDb.getById(mediaId)?.filePath ?? media.filePath;
	})();

	activeNormalizationJobs.set(mediaId, job);
	try {
		return await job;
	} finally {
		activeNormalizationJobs.delete(mediaId);
	}
}

async function shouldNormalizeFile(filePath: string | null): Promise<boolean> {
	if (!(filePath && existsSync(filePath))) {
		return false;
	}
	const extension = path.extname(filePath).toLowerCase();
	if (extension !== ".mp4") {
		return true;
	}
	try {
		return await requiresBrowserSafePlayback(filePath);
	} catch (error) {
		console.error(`[Transcoder] Failed to probe playback compatibility for ${filePath}:`, error);
		return false;
	}
}

async function safeNormalize(sourcePath: string, updateDb: (path: string, size: number) => void): Promise<void> {
	const directory = path.dirname(sourcePath);
	const name = path.basename(sourcePath, path.extname(sourcePath));
	const tempPath = path.join(directory, `${name}.transcoding.mp4`);
	const finalPath = path.join(directory, `${name}.mp4`);
	try {
		await normalizeFileForPlayback(sourcePath, tempPath);
		const isValid = await verifyFileIntegrity(tempPath);
		if (!isValid) {
			console.error(`[Transcoder] Transmuxed file corrupt: ${tempPath}`);
			await fs.unlink(tempPath).catch(() => undefined);
			return;
		}
		if (!(await isDirectPlaybackReady(tempPath))) {
			console.error(`[Transcoder] Finalized file is not browser-safe: ${tempPath}`);
			await fs.unlink(tempPath).catch(() => undefined);
			return;
		}
		await fs.rename(tempPath, finalPath);
		const stats = await fs.stat(finalPath);
		updateDb(finalPath, stats.size);
		if (sourcePath !== finalPath) {
			await fs
				.unlink(sourcePath)
				.catch((error) => console.warn(`Failed to delete original: ${sourcePath}`, error));
		}
	} catch (error) {
		console.error(`[Transcoder] Failed to transmux ${sourcePath}:`, error);
		if (existsSync(tempPath)) {
			await fs.unlink(tempPath).catch(() => undefined);
		}
	}
}
