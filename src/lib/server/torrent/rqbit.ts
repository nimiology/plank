// rqbit (Rust torrent engine) behind the same Torrent/TorrentFile shape WebTorrent gives the rest of
// Plank, so download, status, streaming and finalize code work unchanged. rqbit runs as its own
// service (`rqbit server start <dir>`) and must write to a folder Plank can read.

import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { Torrent, TorrentFile, WebTorrentClient } from "./client";

const POLL_MS = 2000;
const FILE_SYNC_RETRY_MS = 5000;
/** About 30 minutes of retries, enough for rqbit to re-check a large file on a slow disk. */
const FILE_SYNC_RETRIES = 360;

interface RqbitFile {
	name: string;
	components: string[];
	length: number;
	included: boolean;
}

interface RqbitDetails {
	id?: number;
	info_hash: string;
	name: string | null;
	output_folder: string;
	files?: RqbitFile[];
}

interface RqbitStats {
	state: "initializing" | "live" | "paused" | "error";
	file_progress: number[];
	error: string | null;
	progress_bytes: number;
	total_bytes: number;
	finished: boolean;
	live: {
		download_speed?: { mbps?: number };
		snapshot?: { peer_stats?: { live?: number } };
	} | null;
}

class RqbitApi {
	private readonly baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl;
	}

	url(pathname: string): string {
		return new URL(pathname, this.baseUrl).toString();
	}

	async request<T>(pathname: string, init?: RequestInit): Promise<T> {
		const response = await fetch(this.url(pathname), init);
		if (!response.ok) {
			throw new Error(
				`rqbit ${init?.method ?? "GET"} ${pathname} failed: ${response.status} ${await response.text()}`
			);
		}
		return (await response.json()) as T;
	}

	post<T>(pathname: string, body?: unknown): Promise<T> {
		return this.request<T>(pathname, {
			method: "POST",
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}
}

class RqbitFileHandle implements TorrentFile {
	name: string;
	path: string;
	length: number;
	downloaded = 0;
	progress = 0;
	selected = false;
	readonly index: number;
	private readonly torrent: RqbitTorrent;

	constructor(torrent: RqbitTorrent, index: number, file: RqbitFile) {
		this.torrent = torrent;
		this.index = index;
		this.name = file.name.split("/").pop() ?? file.name;
		this.path = file.components.join(path.sep);
		this.length = file.length;
	}

	select(): void {
		this.selected = true;
		this.torrent.scheduleFileSync();
	}

	deselect(): void {
		this.selected = false;
		this.torrent.scheduleFileSync();
	}

	/** rqbit's stream endpoint fetches the needed pieces first, so reads work mid-download. */
	createReadStream(opts: { start?: number; end?: number } = {}): Readable {
		const output = new PassThrough();
		const controller = new AbortController();
		output.on("close", () => controller.abort());
		const start = opts.start ?? 0;
		const range = opts.end === undefined ? `bytes=${start}-` : `bytes=${start}-${opts.end}`;
		fetch(this.torrent.api.url(`/torrents/${this.torrent.infoHash}/stream/${this.index}`), {
			headers: { Range: range },
			signal: controller.signal,
		})
			.then((response) => {
				if (!(response.ok && response.body)) {
					throw new Error(`rqbit stream failed: ${response.status}`);
				}
				Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(output);
			})
			.catch((error: Error) => {
				if (error.name !== "AbortError") {
					output.destroy(error);
				}
			});
		return output;
	}
}

class RqbitTorrent extends EventEmitter {
	files: RqbitFileHandle[] = [];
	infoHash: string;
	name = "";
	path: string;
	progress = 0;
	downloaded = 0;
	downloadSpeed = 0;
	numPeers = 0;
	done = false;
	ready = false;
	private timer: NodeJS.Timeout | null = null;
	private syncTimer: NodeJS.Timeout | null = null;
	private destroyed = false;
	readonly api: RqbitApi;

	constructor(api: RqbitApi, infoHash: string, downloadPath: string) {
		super();
		this.api = api;
		this.infoHash = infoHash.toLowerCase();
		this.path = downloadPath;
	}

	/** Adding waits for metadata on rqbit's side, which can take a while for magnets. */
	async start(magnetLink: string): Promise<void> {
		try {
			const params = new URLSearchParams({ overwrite: "true", output_folder: this.path });
			const response = await this.api.request<{ details: RqbitDetails }>(`/torrents?${params}`, {
				method: "POST",
				body: magnetLink,
			});
			if (this.destroyed) {
				return;
			}
			this.applyDetails(response.details);
			this.ready = true;
			this.emit("metadata");
			this.emit("ready");
			this.timer = setInterval(() => {
				this.poll().catch((error) => console.error(`[rqbit] Poll failed for ${this.infoHash}:`, error));
			}, POLL_MS);
		} catch (error) {
			if (!this.destroyed) {
				this.emit("error", error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private applyDetails(details: RqbitDetails): void {
		this.name = details.name ?? this.infoHash;
		this.path = details.output_folder || this.path;
		this.files = (details.files ?? []).map((file, index) => {
			const handle = new RqbitFileHandle(this, index, file);
			handle.selected = file.included;
			return handle;
		});
	}

	private async poll(): Promise<void> {
		if (this.destroyed) {
			return;
		}
		const stats = await this.api.request<RqbitStats>(`/torrents/${this.infoHash}/stats/v1`);
		if (stats.state === "error") {
			this.emit("error", new Error(stats.error ?? "rqbit reported an error"));
			return;
		}
		for (const file of this.files) {
			file.downloaded = stats.file_progress[file.index] ?? 0;
			file.progress = file.length > 0 ? Math.min(1, file.downloaded / file.length) : 1;
		}
		this.downloaded = stats.progress_bytes;
		this.progress = stats.total_bytes > 0 ? stats.progress_bytes / stats.total_bytes : 0;
		this.downloadSpeed = Math.round((stats.live?.download_speed?.mbps ?? 0) * 1024 * 1024);
		this.numPeers = stats.live?.snapshot?.peer_stats?.live ?? 0;
		this.emit("download", 0);
		if (stats.finished && !this.done) {
			this.done = true;
			this.emit("done");
		}
	}

	/** Batch select/deselect calls into one update; an empty selection pauses instead (rqbit needs one file). */
	scheduleFileSync(delayMs = 50, attempt = 0): void {
		if (this.syncTimer || !this.ready || this.destroyed) {
			return;
		}
		this.syncTimer = setTimeout(() => {
			this.syncTimer = null;
			// Read the selection when sending, so a retry carries the latest select/deselect calls.
			const selected = this.files.filter((file) => file.selected).map((file) => file.index);
			const update =
				selected.length === 0
					? this.api.post(`/torrents/${this.infoHash}/pause`)
					: this.api.post(`/torrents/${this.infoHash}/update_only_files`, { only_files: selected });
			update.catch((error: Error) => {
				// rqbit refuses changes while it re-checks existing data on disk, which can take minutes.
				if (error.message.includes("initializing") && attempt < FILE_SYNC_RETRIES) {
					this.scheduleFileSync(FILE_SYNC_RETRY_MS, attempt + 1);
					return;
				}
				console.error(`[rqbit] File selection failed for ${this.infoHash}:`, error);
			});
		}, delayMs);
	}

	/** Stop polling without touching the torrent in rqbit. */
	detach(): void {
		this.destroyed = true;
		if (this.timer) {
			clearInterval(this.timer);
		}
		if (this.syncTimer) {
			clearTimeout(this.syncTimer);
		}
		this.removeAllListeners();
	}

	destroy(opts?: { destroyStore?: boolean }, callback?: () => void): void {
		this.detach();
		this.api
			.post(`/torrents/${this.infoHash}/${opts?.destroyStore ? "delete" : "forget"}`)
			.catch((error) => console.error(`[rqbit] Failed to remove ${this.infoHash}:`, error))
			.finally(() => callback?.());
	}
}

const MAGNET_INFOHASH = /xt=urn:btih:([a-z0-9]+)/i;

function infoHashFromMagnet(magnetLink: string): string | null {
	return MAGNET_INFOHASH.exec(magnetLink)?.[1]?.toLowerCase() ?? null;
}

export class RqbitClient implements WebTorrentClient {
	private readonly api: RqbitApi;
	private readonly torrents = new Map<string, RqbitTorrent>();

	constructor(baseUrl: string) {
		this.api = new RqbitApi(baseUrl);
	}

	add(torrentId: string, opts?: { path?: string }): Torrent {
		const infoHash = infoHashFromMagnet(torrentId);
		if (!infoHash) {
			throw new Error("rqbit engine needs a magnet link with an info hash");
		}
		// rqbit is a separate process, so it needs an absolute folder.
		const torrent = new RqbitTorrent(this.api, infoHash, path.resolve(opts?.path ?? "."));
		this.torrents.set(torrent.infoHash, torrent);
		torrent.start(torrentId);
		return torrent as unknown as Torrent;
	}

	get(torrentId: string): Torrent | null {
		return (this.torrents.get(torrentId.toLowerCase()) as unknown as Torrent) ?? null;
	}

	remove(torrentId: string, opts?: { destroyStore?: boolean }, callback?: () => void): void {
		const torrent = this.torrents.get(torrentId.toLowerCase());
		this.torrents.delete(torrentId.toLowerCase());
		if (torrent) {
			torrent.destroy(opts, callback);
		} else {
			callback?.();
		}
	}

	on(_event: "error", _callback: (error: Error) => void): void {
		// Errors surface per torrent.
	}

	/** Stops polling only; rqbit keeps its torrents so a restart of Plank can pick them up again. */
	destroy(callback?: (error?: Error | null) => void): void {
		for (const torrent of this.torrents.values()) {
			torrent.detach();
		}
		this.torrents.clear();
		callback?.(null);
	}
}
