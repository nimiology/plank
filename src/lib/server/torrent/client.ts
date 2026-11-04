import type { Readable } from "node:stream";
import parseTorrent from "parse-torrent";
import WebTorrent from "webtorrent";
import type { MediaType } from "$lib/types";
import { getSettings } from "../settings";
import { RqbitClient } from "./rqbit";

export interface TorrentFile {
	name: string;
	path: string;
	length: number;
	downloaded: number;
	progress: number;
	select(): void;
	deselect(): void;
	createReadStream(opts?: { start?: number; end?: number }): Readable;
}

export interface Torrent {
	files: TorrentFile[];
	infoHash: string;
	name: string;
	path: string;
	progress: number;
	downloaded: number;
	downloadSpeed: number;
	numPeers: number;
	done: boolean;
	ready: boolean;
	destroy(opts?: { destroyStore?: boolean }, callback?: () => void): void;
	on(event: "done" | "metadata" | "ready", callback: () => void): void;
	on(event: "upload" | "download", callback: (bytes: number) => void): void;
	on(event: "wire", callback: (wire: unknown) => void): void;
	on(event: "noPeers", callback: (announceType: string) => void): void;
	on(event: "warning" | "error", callback: (err: Error) => void): void;
	on(event: string, callback: (...args: unknown[]) => void): void;
	emit(event: string, ...args: unknown[]): boolean;
}

export interface WebTorrentClient {
	add(
		torrentId: string,
		opts?: { path?: string; announce?: string[] },
		callback?: (torrent: Torrent) => void
	): Torrent;
	remove(torrentId: string, opts?: { destroyStore?: boolean }, callback?: () => void): void;
	get(torrentId: string): Torrent | null;
	on(event: "error", callback: (error: Error) => void): void;
	destroy(callback?: (error?: Error | null) => void): void;
}

export interface ActiveDownload {
	mediaId: string;
	infohash: string;
	mediaType: MediaType;
	torrent: Torrent;
	videoFile: TorrentFile | null;
	videoFiles: TorrentFile[];
	subtitleFiles: TorrentFile[];
	episodeMapping: Map<number, number>;
	progress: number;
	/** Finalization progress from 0 to 1. */
	transcodeProgress: number;
	status: "initializing" | "downloading" | "finalizing" | "complete" | "error";
	totalSize: number;
	error?: string;
}

// Store active downloads keyed by infohash (allows multiple downloads per media)
export const activeDownloads = new Map<string, ActiveDownload>();

// Pending download promises keyed by infohash (prevents duplicate starts of same torrent)
export const pendingDownloads = new Map<string, Promise<void>>();

// Singleton WebTorrent client lifecycle
let clientPromise: Promise<WebTorrentClient> | null = null;
let clientShutdown: Promise<void> | null = null;
let shuttingDown = false;

// Public trackers for better peer discovery
const TRACKERS = [
	"udp://tracker.opentrackr.org:1337/announce",
	"udp://open.tracker.cl:1337/announce",
	"udp://open.stealth.si:80/announce",
	"udp://tracker.torrent.eu.org:451/announce",
];

export function getClient(): Promise<WebTorrentClient> {
	if (shuttingDown) {
		return Promise.reject(new Error("WebTorrent client is shutting down"));
	}
	if (!clientPromise) {
		clientPromise = createClient();
		clientPromise.catch(() => {
			clientPromise = null;
		});
	}
	return clientPromise;
}

/** The engine is read when a client is built; idle clients are released, so a settings change applies on the next download. */
async function createClient(): Promise<WebTorrentClient> {
	const { downloads } = await getSettings();
	if (downloads.engine === "rqbit") {
		console.log(`[Torrent] Using rqbit at ${downloads.rqbitUrl}`);
		return new RqbitClient(downloads.rqbitUrl);
	}
	const torrentClient = new WebTorrent({
		maxConns: 55,
		downloadLimit: -1,
		uploadLimit: -1,
	}) as unknown as WebTorrentClient;
	torrentClient.on("error", (error) => {
		console.error("[WebTorrent] Global client error:", error);
	});
	return torrentClient;
}

export function shutdownTorrentClient(): Promise<void> {
	if (clientShutdown) {
		return clientShutdown;
	}

	shuttingDown = true;
	clientShutdown = (async () => {
		const torrentClient = await clientPromise;
		try {
			if (torrentClient) {
				await new Promise<void>((resolve, reject) => {
					torrentClient.destroy((error) => {
						if (error) {
							reject(error);
							return;
						}
						resolve();
					});
				});
			}
		} finally {
			clientPromise = null;
			activeDownloads.clear();
			pendingDownloads.clear();
		}
	})();
	return clientShutdown;
}

/** Get all active downloads for a media item */
export function getDownloadsForMedia(mediaId: string): ActiveDownload[] {
	const downloads: ActiveDownload[] = [];
	for (const download of activeDownloads.values()) {
		if (download.mediaId === mediaId) {
			downloads.push(download);
		}
	}
	return downloads;
}

export function getDownloadOwnerMediaId(mediaItem: {
	id: string;
	type: MediaType;
	parentId: string | null;
	magnetLink?: string | null;
	infohash?: string | null;
}): string {
	if (mediaItem.type === "episode" && mediaItem.parentId && !(mediaItem.magnetLink || mediaItem.infohash)) {
		return mediaItem.parentId;
	}
	return mediaItem.id;
}

function getEpisodeKey(mediaItem: { seasonNumber: number | null; episodeNumber: number | null }): number | null {
	if (mediaItem.seasonNumber === null || mediaItem.episodeNumber === null) {
		return null;
	}
	return mediaItem.seasonNumber * 100 + mediaItem.episodeNumber;
}

export function resolveEpisodeFileIndex(
	mediaItem: {
		type: MediaType;
		fileIndex: number | null;
		seasonNumber: number | null;
		episodeNumber: number | null;
	},
	downloads: ActiveDownload[]
): number | undefined {
	if (mediaItem.type !== "episode") {
		return mediaItem.fileIndex ?? undefined;
	}
	if (mediaItem.fileIndex !== null) {
		return mediaItem.fileIndex;
	}
	const episodeKey = getEpisodeKey(mediaItem);
	if (episodeKey === null) {
		return undefined;
	}
	return downloads
		.find((download) => download.mediaType === "show" && download.episodeMapping.has(episodeKey))
		?.episodeMapping.get(episodeKey);
}

/** Get or add torrent to client */
export function getOrAddTorrent(
	torrentClient: WebTorrentClient,
	magnetLink: string,
	downloadPath: string,
	mediaId: string
): Torrent | null {
	let infoHash: string | undefined;
	try {
		const parsed = parseTorrent(magnetLink);
		if (typeof parsed === "string") {
			infoHash = parsed;
		} else if (parsed && typeof parsed === "object" && "infoHash" in parsed) {
			infoHash = parsed.infoHash;
		}
	} catch (e) {
		console.warn(`[${mediaId}] Failed to parse magnet link for infoHash check`, e);
	}

	const existing = infoHash ? torrentClient.get(infoHash) : null;
	if (existing) {
		// console.log(`[${mediaId}] Torrent already exists (cached), reusing: ${infoHash}`);
		return existing;
	}

	return torrentClient.add(magnetLink, {
		path: downloadPath,
		announce: TRACKERS,
	});
}

// Destroy the client when no download needs it.
function releaseClientIfIdle(): void {
	if (shuttingDown || activeDownloads.size > 0 || pendingDownloads.size > 0) {
		return;
	}

	const idleClient = clientPromise;
	if (!idleClient) {
		return;
	}

	// Clear the handle first, so a download that starts during the destroy
	// builds a new client instead of using the one that is going away.
	clientPromise = null;
	idleClient
		.then((torrentClient) => {
			torrentClient.destroy(() => {
				console.log("[WebTorrent] Released idle client");
			});
		})
		.catch((error) => {
			console.error("[WebTorrent] Failed to release idle client:", error);
		});
}

export function cleanupDownload(infohash: string, removeFiles: boolean): void {
	const download = activeDownloads.get(infohash);
	if (!download) {
		return;
	}

	download.torrent.destroy({ destroyStore: removeFiles });

	activeDownloads.delete(infohash);
	releaseClientIfIdle();
}

export function hasActiveDownloads(): boolean {
	return activeDownloads.size > 0;
}
