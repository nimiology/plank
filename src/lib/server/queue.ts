// Groups failed and in-flight media into one entry per download
// FEATURE: Download queue page

import type { QueueEntry, QueueEpisode } from "$lib/types";
import { assert } from "$lib/utils";
import { mediaDb, type QueueRow } from "./db";
import { getResolvedProgress, getResolvedStatus } from "./media-progress";
import { parseMagnet } from "./torrent/files";
import { getDownloadStatus, getDownloadStatusByInfohash } from "./torrent/status";

const QUEUED_MEDIA_STATUS: Record<string, true> = {
	pending: true,
	searching: true,
	downloading: true,
	error: true,
	not_found: true,
};

const DOWNLOAD_QUEUE_ID_PREFIX = "download:";
const MEDIA_QUEUE_ID_PREFIX = "media:";

function toQueueEpisode(row: QueueRow): QueueEpisode {
	const { media } = row;
	const size = media.fileSize ?? 0;
	const downloaded = media.downloadedBytes ?? 0;
	return {
		id: media.id,
		title: media.title,
		seasonNumber: media.seasonNumber,
		episodeNumber: media.episodeNumber,
		status: media.status,
		progress: size > 0 ? Math.min(1, downloaded / size) : (media.progress ?? 0),
	};
}

function createQueueEntry(row: QueueRow): QueueEntry {
	const { download, media } = row;
	let status = media.status ?? "pending";
	let progress = media.progress ?? 0;
	if (download) {
		progress = download.progress ?? 0;
		switch (download.status) {
			case "error":
				status = "error";
				break;
			case "downloading":
				status = "downloading";
				break;
			default:
				status =
					media.status === "pending" || media.status === "searching" || media.status === "downloading"
						? media.status
						: "pending";
		}
	}
	return {
		id: download ? `${DOWNLOAD_QUEUE_ID_PREFIX}${download.id}` : `${MEDIA_QUEUE_ID_PREFIX}${media.id}`,
		downloadId: download?.id ?? null,
		downloadInfohash: download?.infohash ?? null,
		sourceTitle: download ? parseMagnet(download.magnetLink).name || download.infohash.slice(0, 8) : null,
		media,
		showTitle: row.showTitle,
		status,
		progress,
		downloadSpeed: 0,
		peers: 0,
		totalSize: media.fileSize ?? 0,
		transcodeProgress: 0,
		episodes: [],
	};
}

/** An episode with no source of its own rides on the download of its show. */
function isFoldableEpisode(row: QueueRow): boolean {
	const { media } = row;
	return (
		row.download === null &&
		media.type === "episode" &&
		media.parentId !== null &&
		!(media.magnetLink || media.infohash)
	);
}

function isQueued(row: QueueRow): boolean {
	return row.download !== null || Boolean(row.media.status && QUEUED_MEDIA_STATUS[row.media.status]);
}

/**
 * Group queue rows by download. An episode folds only when its parent
 * show has one unambiguous queue entry.
 */
function foldQueueRows(rows: QueueRow[]): QueueEntry[] {
	const entries: QueueEntry[] = [];
	const episodeRows: QueueRow[] = [];
	for (const row of rows) {
		if (isFoldableEpisode(row)) {
			episodeRows.push(row);
		} else if (isQueued(row)) {
			entries.push(createQueueEntry(row));
		}
	}

	/** The show entry that owns folded episodes. Null when the show has more than one, so nothing folds. */
	const owners = new Map<string, QueueEntry | null>();
	for (const entry of entries) {
		if (entry.media.type === "show") {
			owners.set(entry.media.id, owners.has(entry.media.id) ? null : entry);
		}
	}

	for (const row of episodeRows) {
		const parentId = row.media.parentId;
		assert(parentId !== null, "foldQueueRows: folded episode must have a parent");
		const owner = owners.get(parentId);
		if (owner) {
			owner.episodes.push(toQueueEpisode(row));
		} else if (isQueued(row)) {
			entries.push(createQueueEntry(row));
		}
	}

	for (const entry of entries) {
		entry.episodes.sort(
			(a, b) => (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) || (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0)
		);
	}

	assert(
		new Set(entries.map((entry) => entry.id)).size === entries.length,
		"foldQueueRows: queue ids must be unique"
	);
	assert(entries.length <= rows.length, "foldQueueRows: entries must not outnumber rows");
	return entries;
}

function episodeKey(episode: QueueEpisode): number | null {
	if (episode.seasonNumber === null || episode.episodeNumber === null) {
		return null;
	}
	return episode.seasonNumber * 100 + episode.episodeNumber;
}

/** Overlay the live torrent stats on the stored row. */
function withLiveStats(entry: QueueEntry): QueueEntry {
	const download = entry.downloadInfohash
		? getDownloadStatusByInfohash(entry.downloadInfohash)
		: getDownloadStatus(entry.media.id);
	const liveEpisodes = download?.episodeProgress;
	return {
		...entry,
		status: entry.downloadId === null ? getResolvedStatus(entry.media) : (download?.status ?? entry.status),
		progress: entry.downloadId === null ? getResolvedProgress(entry.media) : (download?.progress ?? entry.progress),
		downloadSpeed: download?.downloadSpeed ?? 0,
		peers: download?.peers ?? 0,
		totalSize: download?.totalSize || entry.totalSize,
		transcodeProgress: download?.transcodeProgress ?? 0,
		episodes: entry.episodes.map((episode) => {
			const key = episodeKey(episode);
			const live = key === null ? undefined : liveEpisodes?.get(key);
			return live === undefined ? episode : { ...episode, progress: live };
		}),
	};
}

/** One live snapshot of every queue entry in an organization. */
export function buildQueue(organizationId: string): QueueEntry[] {
	return foldQueueRows(mediaDb.listQueueRows(organizationId)).map(withLiveStats);
}
