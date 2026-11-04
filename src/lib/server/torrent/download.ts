import fs from "node:fs/promises";
import path from "node:path";
import ptt from "parse-torrent-title";
import type { MediaType } from "$lib/types";
import { assert } from "$lib/utils";
import { downloadsDb, mediaDb } from "../db";
import { SUPPORTED_VIDEO_FORMATS } from "../ffmpeg";
import { PATHS } from "../paths";
import { getSettings } from "../settings";
import { searchMovie, searchTVShow } from "../tmdb";
import {
	type ActiveDownload,
	activeDownloads,
	cleanupDownload,
	getClient,
	getDownloadsForMedia,
	getOrAddTorrent,
	pendingDownloads,
	type Torrent,
} from "./client";
import {
	autoNumberFiles,
	findSubtitleFiles,
	findVideoFile,
	findVideoFiles,
	mapFilesToEpisodes,
	parseMagnet,
} from "./files";
import { createEpisodesFromMapping, moveToLibrary } from "./finalize";

async function ensureDirectories(): Promise<void> {
	await fs.mkdir(PATHS.temp, { recursive: true });
	await fs.mkdir(PATHS.library, { recursive: true });
}

async function fetchAndUpdateMetadata(mediaId: string, fileName: string, mediaType: MediaType): Promise<void> {
	try {
		// Check if media already has TMDB data - skip entirely if so
		const existingMedia = mediaDb.getById(mediaId);
		if (existingMedia?.tmdbId) {
			// console.log(
			// 	`[${mediaId}] Media already has TMDB data (tmdbId: ${existingMedia.tmdbId}), skipping metadata fetch`
			// );
			return;
		}

		// Also skip if we already have a poster URL (means TMDB data was fetched successfully during creation)
		if (existingMedia?.posterUrl) {
			// console.log(`[${mediaId}] Media already has poster data, skipping metadata fetch`);
			return;
		}

		// Parse title and year from file name
		const parsed = ptt.parse(fileName);
		// console.log(`[${mediaId}] Parsed filename: title="${parsed.title}", year=${parsed.year}`);

		if (!parsed.title) {
			// console.log(`[${mediaId}] Could not parse title from filename`);
			return;
		}

		// Update title from filename (only if we don't have TMDB data)
		mediaDb.updateMetadata(mediaId, {
			title: parsed.title,
			year: parsed.year || null,
		});

		const settings = await getSettings();

		// Search TMDB if API key is configured
		if (settings.tmdb.apiKey) {
			// console.log(
			// 	`[${mediaId}] Searching TMDB for: "${parsed.title}" (${parsed.year || 'no year'})`
			// );

			const results =
				mediaType === "show"
					? await searchTVShow(parsed.title, parsed.year)
					: await searchMovie(parsed.title, parsed.year);

			// console.log(`[${mediaId}] TMDB returned ${results.length} results`);

			if (results.length > 0) {
				const tmdbData = results[0];
				// console.log(
				// 	`[${mediaId}] Using TMDB result: "${tmdbData.title}" (${tmdbData.year}), poster: ${tmdbData.posterUrl}`
				// );
				mediaDb.updateMetadata(mediaId, {
					title: tmdbData.title,
					year: tmdbData.year,
					posterUrl: tmdbData.posterUrl,
					backdropUrl: tmdbData.backdropUrl,
					overview: tmdbData.overview,
					tmdbId: tmdbData.tmdbId,
					totalSeasons: tmdbData.totalSeasons,
				});
			}
		}
	} catch (e) {
		console.error(`[${mediaId}] Failed to fetch metadata:`, e);
	}
}

export async function startDownload(mediaId: string, magnetLink: string): Promise<void> {
	// Extract infohash from magnet link using our reliable regex-based parser
	const { infohash } = parseMagnet(magnetLink);

	if (!infohash) {
		console.error(`[${mediaId}] Could not extract infohash from magnet link`);
		throw new Error("Invalid magnet link - could not extract infohash");
	}

	// Check if this specific torrent is already active
	if (activeDownloads.has(infohash)) {
		// console.log(`[${mediaId}] Torrent ${infohash} already active`);
		return;
	}

	// Check if there's a pending download promise for this torrent
	const pending = pendingDownloads.get(infohash);
	if (pending) {
		// console.log(`[${mediaId}] Torrent ${infohash} pending, waiting...`);
		return pending;
	}

	// Create a promise for this download initialization
	const downloadPromise = initializeDownload(mediaId, magnetLink, infohash);
	pendingDownloads.set(infohash, downloadPromise);

	try {
		await downloadPromise;
	} finally {
		pendingDownloads.delete(infohash);
	}
}

async function handleDownloadComplete(infohash: string, download: ActiveDownload, torrent: Torrent): Promise<void> {
	// const logPrefix = `[${download.mediaId}:${infohash.slice(0, 8)}]`;

	// Prevent double-completion
	if (download.status === "complete" || download.status === "finalizing") {
		// console.log(`${logPrefix} Already marked complete, skipping`);
		return;
	}

	// console.log(`${logPrefix} Handling download completion...`);
	download.status = "finalizing";
	download.progress = 1;
	download.transcodeProgress = 0;

	// Stop seeding - deselect all files to prevent uploading
	for (const f of torrent.files) {
		f.deselect();
	}
	// console.log(`${logPrefix} Stopped seeding`);

	try {
		await moveToLibrary(download.mediaId, download);
	} catch (err) {
		console.error("[Finalizer] Post-download finalization failed:", err);
		download.status = "error";
		download.error = err instanceof Error ? err.message : "Failed to finalize download";
		const failedRecord = downloadsDb.getByInfohash(download.mediaId, infohash);
		if (failedRecord) {
			downloadsDb.updateProgress(failedRecord.id, download.progress, "error");
		}
		updateMediaStatusFromDownloads(download.mediaId);
		cleanupDownload(infohash, false);
		return;
	}
	download.status = "complete";

	// Update download record in database
	const downloadRecord = downloadsDb.getByInfohash(download.mediaId, infohash);
	if (downloadRecord) {
		downloadsDb.updateProgress(downloadRecord.id, 1, "complete");
		// console.log(`${logPrefix} Updated download record ${downloadRecord.id} to complete`);
	}

	// Update media status if all downloads for this media are complete
	updateMediaStatusFromDownloads(download.mediaId);
	cleanupDownload(download.infohash, true);
}

/** Update media status based on all active downloads for that media */
function updateMediaStatusFromDownloads(mediaId: string): void {
	const downloads = getDownloadsForMedia(mediaId);
	// No tracked downloads (e.g. the list was cleared during shutdown) says nothing about the media.
	if (downloads.length === 0) {
		return;
	}
	const allComplete = downloads.every((d) => d.status === "complete");
	const anyError = downloads.some((d) => d.status === "error");

	if (allComplete) {
		mediaDb.updateProgress(mediaId, 1, "complete");
	} else if (anyError) {
		// If any download has error but others are still going, keep downloading status
		const hasActiveDownloads = downloads.some(
			(d) => d.status === "downloading" || d.status === "initializing" || d.status === "finalizing"
		);
		if (!hasActiveDownloads) {
			mediaDb.updateProgress(mediaId, 0, "error");
		}
	}
}

// Periodically check if video file is complete (fallback for missed 'done' events)
function startCompletionChecker(infohash: string, download: ActiveDownload, torrent: Torrent): void {
	const logPrefix = `[${download.mediaId}:${infohash.slice(0, 8)}]`;
	let lastDownloaded = torrent.downloaded;
	let stalledChecks = 0;

	const checkInterval = setInterval(() => {
		if (!activeDownloads.has(infohash) || download.status === "complete" || download.status === "finalizing") {
			clearInterval(checkInterval);
			return;
		}

		if (download.mediaType === "movie" && download.videoFile?.progress === 1) {
			clearInterval(checkInterval);
			handleDownloadComplete(infohash, download, torrent).catch((err) => {
				console.error(`${logPrefix} Error in completion checker:`, err);
			});
			return;
		}

		if (download.mediaType === "show") {
			const selectedComplete = download.videoFiles.every((f) => f.progress === 1);
			if (selectedComplete) {
				clearInterval(checkInterval);
				handleDownloadComplete(infohash, download, torrent).catch((err) => {
					console.error(`${logPrefix} Error in completion checker:`, err);
				});
				return;
			}
		}

		const downloaded = torrent.downloaded;
		if (downloaded !== lastDownloaded) {
			lastDownloaded = downloaded;
			stalledChecks = 0;
			return;
		}

		stalledChecks += 1;
		if (stalledChecks < 60) {
			return;
		}

		clearInterval(checkInterval);
		torrent.emit("error", new Error("Download stalled for 5 minutes with no progress"));
	}, 5000); // This 5 sec interval with a 60 maximum checks makes for a 5 min stall limit
}

/** Handle TV show torrent ready */
async function handleTVShowReady(
	mediaId: string,
	download: ActiveDownload,
	torrent: Torrent,
	reject: (err: Error) => void
): Promise<boolean> {
	const logPrefix = `[${mediaId}:${download.infohash.slice(0, 8)}]`;
	download.videoFiles = findVideoFiles(torrent.files);

	if (download.videoFiles.length === 0) {
		const allFiles = torrent.files.map((f) => f.name).join(", ");
		console.error(`${logPrefix} No supported video files found. Files: ${allFiles}`);
		download.status = "error";
		download.error = `No supported video file found. Supported formats: ${SUPPORTED_VIDEO_FORMATS.join(", ")}`;
		cleanupDownload(download.infohash, true);
		reject(new Error("No supported video file found in torrent"));
		return false;
	}

	// console.log(`${logPrefix} Found ${download.videoFiles.length} video files for TV show`);

	// Parse torrent name to see if we can detect a season number
	// Fallback to undefined if not found
	const parsedTorrent = ptt.parse(torrent.name);
	const defaultSeason = parsedTorrent.season;
	if (defaultSeason) {
		// console.log(`${logPrefix} Detected default season from torrent name: Season ${defaultSeason}`);
	}

	download.episodeMapping = mapFilesToEpisodes(download.videoFiles, defaultSeason);
	if (download.episodeMapping.size === 0) {
		// console.log(`${logPrefix} Episode mapping failed, using auto-number fallback`);
		download.episodeMapping = autoNumberFiles(download.videoFiles, defaultSeason);
	}

	try {
		await createEpisodesFromMapping(mediaId, download.videoFiles, download.episodeMapping);
	} catch (e) {
		console.error(`${logPrefix} Failed to create episodes:`, e);
		// Continue anyway - we'll retry in moveTVShowToLibrary if needed
	}

	download.totalSize = download.videoFiles.reduce((sum, f) => sum + f.length, 0);

	for (const f of torrent.files) {
		f.deselect();
	}
	for (const f of download.videoFiles) {
		f.select();
	}

	// Also select subtitle files for download
	download.subtitleFiles = findSubtitleFiles(torrent.files);
	for (const f of download.subtitleFiles) {
		f.select();
	}

	fetchAndUpdateMetadata(mediaId, download.videoFiles[0]?.name ?? torrent.name, "show");
	return true;
}

/** Handle movie torrent ready */
function handleMovieReady(
	mediaId: string,
	actualMediaType: MediaType,
	download: ActiveDownload,
	torrent: Torrent,
	reject: (err: Error) => void
): boolean {
	const logPrefix = `[${mediaId}:${download.infohash.slice(0, 8)}]`;
	const videoFile = findVideoFile(torrent.files);

	if (!videoFile) {
		const allFiles = torrent.files.map((f) => f.name).join(", ");
		console.error(`${logPrefix} No supported video file found. Files: ${allFiles}`);
		download.status = "error";
		download.error = `No supported video file found. Supported formats: ${SUPPORTED_VIDEO_FORMATS.join(", ")}`;
		cleanupDownload(download.infohash, true);
		reject(new Error("No supported video file found in torrent"));
		return false;
	}

	// console.log(
	// 	`${logPrefix} Selected video: ${videoFile.name} (${(videoFile.length / 1024 / 1024).toFixed(2)} MB)`
	// );

	if (actualMediaType === "movie") {
		fetchAndUpdateMetadata(mediaId, videoFile.name, "movie");
	}

	for (const f of torrent.files) {
		f.deselect();
	}
	videoFile.select();

	// Also select subtitle files for download
	download.subtitleFiles = findSubtitleFiles(torrent.files);
	for (const f of download.subtitleFiles) {
		f.select();
	}

	download.videoFile = videoFile;
	download.totalSize = videoFile.length;
	return true;
}

/** Check if download is already complete */
function checkAlreadyComplete(infohash: string, download: ActiveDownload, torrent: Torrent): void {
	const logPrefix = `[${download.mediaId}:${infohash.slice(0, 8)}]`;

	if (download.mediaType === "movie" && (download.videoFile?.progress === 1 || torrent.done)) {
		// console.log(`${logPrefix} Video file already complete, triggering done handler`);
		setImmediate(() => {
			handleDownloadComplete(infohash, download, torrent).catch((err) => {
				console.error(`${logPrefix} Error handling already-complete download:`, err);
			});
		});
	} else if (download.mediaType === "show") {
		const allComplete = download.videoFiles.every((f) => f.progress === 1);
		if (allComplete || torrent.done) {
			// console.log(`${logPrefix} All TV files already complete, triggering done handler`);
			setImmediate(() => {
				handleDownloadComplete(infohash, download, torrent).catch((err) => {
					console.error(`${logPrefix} Error handling already-complete download:`, err);
				});
			});
		}
	}
}

async function initializeDownload(mediaId: string, magnetLink: string, infohash: string): Promise<void> {
	await ensureDirectories();

	// Use infohash in path to allow multiple torrents for same media
	const downloadPath = path.join(PATHS.temp, mediaId, infohash);
	await fs.mkdir(downloadPath, { recursive: true });

	const mediaItem = mediaDb.getById(mediaId);
	const mediaType: MediaType = mediaItem?.type === "show" ? "show" : "movie";
	const actualMediaType = mediaItem?.type ?? "movie";

	// console.log(`[${mediaId}:${infohash.slice(0, 8)}] Starting download (type: ${mediaType})...`);
	// console.log(`[${mediaId}:${infohash.slice(0, 8)}] Magnet: ${magnetLink.substring(0, 80)}...`);
	mediaDb.updateProgress(mediaId, 0, "downloading");

	const torrentClient = await getClient();

	return new Promise((resolve, reject) => {
		let torrent: Torrent | null;

		try {
			torrent = getOrAddTorrent(torrentClient, magnetLink, downloadPath, mediaId);
			if (!torrent) {
				reject(new Error("Failed to add torrent"));
				return;
			}
		} catch (e) {
			console.error(`[${mediaId}:${infohash.slice(0, 8)}] Failed to add torrent:`, e);
			reject(e);
			return;
		}

		const download: ActiveDownload = {
			mediaId,
			infohash,
			mediaType,
			torrent,
			videoFile: null,
			videoFiles: [],
			subtitleFiles: [],
			episodeMapping: new Map(),
			progress: 0,
			transcodeProgress: 0,
			status: "initializing",
			totalSize: 0,
		};

		activeDownloads.set(infohash, download);

		const logPrefix = `[${mediaId}:${infohash.slice(0, 8)}]`;

		// torrent.on('wire', () => {
		// 	console.log(`${logPrefix} Connected to peer, total: ${torrent?.numPeers}`);
		// });

		// torrent.on('noPeers', (announceType: string) => {
		// 	console.log(`${logPrefix} No peers from ${announceType}`);
		// });

		// torrent.on('warning', (err: Error) => {
		// 	console.warn(`${logPrefix} Warning:`, err.message);
		// });

		torrent.on("ready", async () => {
			if (!torrent) {
				return;
			}
			// console.log(`${logPrefix} Torrent ready: ${torrent.infoHash}`);

			const success =
				mediaType === "show"
					? await handleTVShowReady(mediaId, download, torrent, reject)
					: handleMovieReady(mediaId, actualMediaType, download, torrent, reject);

			if (!success) {
				return;
			}

			download.status = "downloading";
			startCompletionChecker(infohash, download, torrent);
			checkAlreadyComplete(infohash, download, torrent);
			resolve();
		});

		torrent.on("download", () => {
			if (download.mediaType === "movie" && download.videoFile) {
				download.progress = download.videoFile.progress;
			} else if (download.mediaType === "show" && download.videoFiles.length > 0) {
				const totalDownloaded = download.videoFiles.reduce((sum, f) => sum + f.downloaded, 0);
				download.progress = totalDownloaded / download.totalSize;
			}

			// Don't update media progress here - it will be aggregated in getDownloadStatus
		});

		torrent.on("done", () => {
			if (!torrent) {
				return;
			}
			// console.log(`${logPrefix} Torrent 'done' event fired!`);
			handleDownloadComplete(infohash, download, torrent).catch((err) => {
				console.error(`${logPrefix} Error in done handler:`, err);
			});
		});

		torrent.on("error", (err: Error) => {
			console.error(`${logPrefix} Torrent error:`, err);
			download.status = "error";
			download.error = err.message;
			const downloadRecord = downloadsDb.getByInfohash(mediaId, infohash);
			if (downloadRecord) {
				downloadsDb.updateProgress(downloadRecord.id, download.progress, "error");
			}
			mediaDb.updateProgress(mediaId, download.progress, "error");
			// Tear down errored torrents so peer connections, timers, and buffers do not linger.
			cleanupDownload(infohash, false);
			reject(err);
		});

		setTimeout(() => {
			if (download.status === "initializing") {
				const timeoutError = "No seeders found - the torrent may be dead or unavailable";
				download.status = "error";
				download.error = timeoutError;
				const downloadRecord = downloadsDb.getByInfohash(mediaId, infohash);
				if (downloadRecord) {
					downloadsDb.updateProgress(downloadRecord.id, 0, "error");
				}
				mediaDb.updateProgress(mediaId, 0, "error");
				cleanupDownload(infohash, true);
				reject(new Error(timeoutError));
			}
		}, 120_000);

		if (torrent.ready) {
			setImmediate(() => {
				torrent?.emit("ready");
			});
		}
	});
}

/** Cancel one torrent without affecting other season packs for the same show. */
export async function cancelDownloadByInfohash(mediaId: string, infohash: string): Promise<void> {
	pendingDownloads.delete(infohash);
	const download = activeDownloads.get(infohash);
	if (!download) {
		return;
	}
	assert(download.mediaId === mediaId, "cancelDownloadByInfohash: download owner must match");
	await new Promise<void>((resolve) => {
		download.torrent.destroy({ destroyStore: true }, () => {
			activeDownloads.delete(infohash);
			resolve();
		});
	});
}

// Cancel all active downloads for a media item
export async function cancelDownload(mediaId: string): Promise<void> {
	// console.log(`[${mediaId}] Cancelling all downloads...`);
	const mediaItem = mediaDb.getById(mediaId);
	const targetMediaIds =
		mediaItem?.type === "show"
			? [mediaId, ...mediaDb.getEpisodesByParentId(mediaId).map((episode) => episode.id)]
			: [mediaId];
	const downloads = targetMediaIds.flatMap((targetMediaId) => getDownloadsForMedia(targetMediaId));

	// Also remove any pending downloads for this media
	for (const [infohash, download] of activeDownloads.entries()) {
		if (targetMediaIds.includes(download.mediaId)) {
			pendingDownloads.delete(infohash);
		}
	}

	// Destroy all torrents for this media
	const destroyPromises = downloads.map(
		(download) =>
			new Promise<void>((resolve) => {
				download.torrent.destroy({ destroyStore: true }, () => {
					// console.log(`[${mediaId}:${download.infohash.slice(0, 8)}] Download cancelled`);
					activeDownloads.delete(download.infohash);
					resolve();
				});
			})
	);

	await Promise.all(destroyPromises);
}
