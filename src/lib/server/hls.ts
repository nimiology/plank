// Live conversion for browser playback: ffmpeg writes short HLS segments starting wherever the
// viewer is, so playback starts in seconds instead of after converting the whole file.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { type EncoderId, FFMPEG_PATH, FFPROBE_PATH, getEncoderArgs, resolveEncoder } from "./encoder";
import { getPlaybackCompatibility, probeFile } from "./ffmpeg";
import { sanitizeFilename } from "./images";
import { PATHS } from "./paths";
import { getSettings } from "./settings";

const SEGMENT_SECONDS = 4;
/** ffmpeg pauses once it is this many segments ahead of the player, to save CPU and disk. */
const MAX_SEGMENTS_AHEAD = 30;
/** A request this far past the newest segment restarts ffmpeg there instead of waiting. */
const RESTART_GAP = 6;
const IDLE_KILL_MS = 60_000;
const SEGMENT_WAIT_MS = 45_000;
const MAX_HEIGHT = 1080;
const BROWSER_PIXEL_FORMATS = new Set(["yuv420p", "yuvj420p"]);
const DIRECT_EXTENSIONS = new Set([".mp4", ".m4v", ".webm"]);
const COPY_AUDIO_CODECS = new Set(["aac", "mp3"]);

export interface PlaybackPlan {
	mode: "direct" | "hls";
	/** H.264 that only needs a new container; anything else is re-encoded. */
	copyVideo: boolean;
	copyAudio: boolean;
	duration: number;
	height: number | null;
}

const planCache = new Map<string, Promise<PlaybackPlan>>();

async function buildPlan(filePath: string): Promise<PlaybackPlan> {
	const [probe, compatibility] = await Promise.all([probeFile(filePath), getPlaybackCompatibility(filePath)]);
	const extension = path.extname(filePath).toLowerCase();
	const copyVideo = probe.videoCodec === "h264" && BROWSER_PIXEL_FORMATS.has(probe.pixelFormat ?? "yuv420p");
	const copyAudio =
		COPY_AUDIO_CODECS.has(probe.audioCodec ?? "") &&
		(probe.audioChannels ?? 0) > 0 &&
		(probe.audioChannels ?? 0) <= 2;
	const direct =
		DIRECT_EXTENSIONS.has(extension) &&
		!compatibility.requiresNormalization &&
		BROWSER_PIXEL_FORMATS.has(probe.pixelFormat ?? "yuv420p");
	return {
		mode: direct ? "direct" : "hls",
		copyVideo,
		copyAudio,
		duration: probe.duration ?? 0,
		height: probe.videoHeight ?? null,
	};
}

/** Whether the browser can play the file as is, or needs the live HLS stream. */
export function getPlaybackPlan(filePath: string): Promise<PlaybackPlan> {
	let plan = planCache.get(filePath);
	if (!plan) {
		plan = buildPlan(filePath);
		plan.catch(() => planCache.delete(filePath));
		planCache.set(filePath, plan);
	}
	return plan;
}

// --- Segment boundaries ---

/** Video keyframe times. Copied video can only be cut on keyframes. */
function probeKeyframes(filePath: string): Promise<number[]> {
	return new Promise((resolve, reject) => {
		execFile(
			FFPROBE_PATH,
			[
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"packet=pts_time,flags",
				"-of",
				"csv=p=0",
				filePath,
			],
			{ maxBuffer: 256 * 1024 * 1024 },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				const times: number[] = [];
				for (const line of stdout.split("\n")) {
					const [time, flags] = line.split(",");
					const value = Number.parseFloat(time);
					if (flags?.includes("K") && Number.isFinite(value)) {
						times.push(value);
					}
				}
				resolve(times.sort((a, b) => a - b));
			}
		);
	});
}

/** Segment start times plus the end time: segment i covers [b[i], b[i+1]). */
export function buildBoundaries(duration: number, keyframes: number[] | null): number[] {
	const boundaries = [0];
	if (keyframes) {
		for (const time of keyframes) {
			if (time - (boundaries.at(-1) ?? 0) >= SEGMENT_SECONDS && time < duration) {
				boundaries.push(time);
			}
		}
	} else {
		for (let time = SEGMENT_SECONDS; time < duration; time += SEGMENT_SECONDS) {
			boundaries.push(time);
		}
	}
	boundaries.push(duration);
	return boundaries;
}

// shortcut: boundaries live in memory, so the first play after a restart re-reads keyframes; cache to disk if that gets slow.
const boundaryCache = new Map<string, Promise<number[]>>();

async function getBoundaries(filePath: string): Promise<number[]> {
	let boundaries = boundaryCache.get(filePath);
	if (!boundaries) {
		boundaries = (async () => {
			const plan = await getPlaybackPlan(filePath);
			return buildBoundaries(plan.duration, plan.copyVideo ? await probeKeyframes(filePath) : null);
		})();
		boundaries.catch(() => boundaryCache.delete(filePath));
		boundaryCache.set(filePath, boundaries);
	}
	return boundaries;
}

export async function buildPlaylist(filePath: string): Promise<string> {
	const boundaries = await getBoundaries(filePath);
	const lines: string[] = [];
	let longest = SEGMENT_SECONDS;
	for (let i = 0; i < boundaries.length - 1; i++) {
		const length = boundaries[i + 1] - boundaries[i];
		longest = Math.max(longest, length);
		lines.push(`#EXTINF:${length.toFixed(3)},`, `${i}.ts`);
	}
	return [
		"#EXTM3U",
		"#EXT-X-VERSION:3",
		`#EXT-X-TARGETDURATION:${Math.ceil(longest)}`,
		"#EXT-X-MEDIA-SEQUENCE:0",
		"#EXT-X-PLAYLIST-TYPE:VOD",
		...lines,
		"#EXT-X-ENDLIST",
		"",
	].join("\n");
}

// --- The ffmpeg job ---

interface Job {
	mediaId: string;
	filePath: string;
	dir: string;
	start: number;
	encoder: EncoderId | null;
	process: ChildProcess;
	highest: number;
	lastRequested: number;
	lastAccess: number;
	paused: boolean;
	exited: boolean;
	error: string | null;
	timer: NodeJS.Timeout;
}

// One conversion at a time: the home server has little RAM and two CPU cores.
let job: Job | null = null;
/** Segments already written for the media in `job`, kept across restarts at a new position. */
let finished = new Set<number>();

function segmentPath(dir: string, index: number): string {
	return path.join(dir, `${index}.ts`);
}

function stopJob(current: Job): void {
	clearInterval(current.timer);
	if (!current.exited) {
		if (current.paused) {
			current.process.kill("SIGCONT");
		}
		current.process.kill("SIGKILL");
	}
}

async function readFinished(current: Job): Promise<void> {
	const list = await fs.readFile(path.join(current.dir, `list-${current.start}.csv`), "utf8").catch(() => "");
	for (const line of list.split("\n")) {
		const index = Number.parseInt(line, 10);
		if (Number.isFinite(index)) {
			finished.add(index);
			current.highest = Math.max(current.highest, index);
		}
	}
}

function buildArgs(
	filePath: string,
	dir: string,
	start: number,
	boundaries: number[],
	plan: PlaybackPlan,
	encoder: EncoderId | null
): string[] {
	const encoderArgs = encoder ? getEncoderArgs(encoder, { maxHeight: MAX_HEIGHT }) : null;
	// Timestamps stay absolute (-copyts) so segments from different jobs line up, but the
	// segment muxer and -force_key_frames measure cut times from where this job starts.
	const cuts = boundaries.slice(start + 1, -1).map((time) => (time - boundaries[start]).toFixed(3));
	const args = ["-hide_banner", "-loglevel", "error", "-nostdin", ...(encoderArgs?.input ?? [])];
	if (start > 0) {
		args.push("-ss", boundaries[start].toFixed(3));
	}
	args.push("-copyts", "-i", filePath, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn");
	if (encoderArgs) {
		args.push("-vf", encoderArgs.filter, ...encoderArgs.output);
		if (cuts.length > 0) {
			args.push("-force_key_frames", cuts.join(","));
		}
	} else {
		args.push("-c:v", "copy");
	}
	args.push(...(plan.copyAudio ? ["-c:a", "copy"] : ["-c:a", "aac", "-ac", "2", "-b:a", "192k"]));
	args.push(
		"-avoid_negative_ts",
		"disabled",
		"-muxdelay",
		"0",
		"-f",
		"segment",
		"-segment_format",
		"mpegts",
		"-segment_start_number",
		String(start),
		"-segment_list",
		path.join(dir, `list-${start}.csv`),
		"-segment_list_type",
		"csv"
	);
	if (cuts.length > 0) {
		args.push("-segment_times", cuts.join(","));
	}
	args.push(path.join(dir, "%d.ts"));
	return args;
}

async function startJob(mediaId: string, filePath: string, start: number, forceCpu = false): Promise<Job> {
	const [plan, boundaries] = await Promise.all([getPlaybackPlan(filePath), getBoundaries(filePath)]);
	const dir = path.join(PATHS.hls, sanitizeFilename(mediaId));

	if (job) {
		stopJob(job);
	}
	if (job?.mediaId !== mediaId || job.filePath !== filePath) {
		finished = new Set();
		await fs.rm(PATHS.hls, { recursive: true, force: true });
	}
	await fs.mkdir(dir, { recursive: true });
	await fs.rm(path.join(dir, `list-${start}.csv`), { force: true });

	let encoder: EncoderId | null = null;
	if (!plan.copyVideo) {
		encoder = forceCpu ? "libx264" : await resolveEncoder((await getSettings()).playback.encoder);
	}
	const child = spawn(FFMPEG_PATH, buildArgs(filePath, dir, start, boundaries, plan, encoder), {
		stdio: ["ignore", "ignore", "pipe"],
	});

	const current: Job = {
		mediaId,
		filePath,
		dir,
		start,
		encoder,
		process: child,
		highest: start - 1,
		lastRequested: start,
		lastAccess: Date.now(),
		paused: false,
		exited: false,
		error: null,
		timer: setInterval(() => {
			readFinished(current).then(() => throttle(current));
		}, 500),
	};

	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = (stderr + chunk.toString()).slice(-2000);
	});
	child.on("error", (error) => {
		current.exited = true;
		current.error = error.message;
	});
	child.on("exit", (code, signal) => {
		current.exited = true;
		if (code !== 0 && signal !== "SIGKILL") {
			current.error = stderr.trim() || `ffmpeg exited with code ${code}`;
			console.error(`[HLS] ffmpeg failed for ${mediaId} at segment ${start}:`, current.error);
		}
		readFinished(current).catch(() => undefined);
	});

	console.log(
		`[HLS] ${mediaId}: segment ${start}, video ${encoder ?? "copy"}, audio ${plan.copyAudio ? "copy" : "aac"}`
	);
	job = current;
	return current;
}

function throttle(current: Job): void {
	if (current !== job || current.exited) {
		clearInterval(current.timer);
		return;
	}
	if (Date.now() - current.lastAccess > IDLE_KILL_MS) {
		console.log(`[HLS] ${current.mediaId}: idle, stopping ffmpeg`);
		stopJob(current);
		job = null;
		return;
	}
	const ahead = current.highest - current.lastRequested;
	if (!current.paused && ahead > MAX_SEGMENTS_AHEAD) {
		current.process.kill("SIGSTOP");
		current.paused = true;
	} else if (current.paused && ahead < MAX_SEGMENTS_AHEAD / 2) {
		current.process.kill("SIGCONT");
		current.paused = false;
	}
}

// Segment requests can arrive together; deciding and starting a job must not interleave.
let jobLock: Promise<unknown> = Promise.resolve();

function withJobLock<T>(work: () => Promise<T>): Promise<T> {
	const result = jobLock.then(work);
	jobLock = result.catch(() => undefined);
	return result;
}

function needsRestart(current: Job | null, mediaId: string, filePath: string, index: number): boolean {
	if (!current || current.mediaId !== mediaId || current.filePath !== filePath) {
		return true;
	}
	if (index < current.start || index > current.highest + RESTART_GAP) {
		return true;
	}
	return current.exited && !finished.has(index);
}

/** Path of a finished segment, starting or moving ffmpeg when the viewer jumps somewhere new. */
export async function getSegment(mediaId: string, filePath: string, index: number): Promise<string | null> {
	const boundaries = await getBoundaries(filePath);
	if (!Number.isInteger(index) || index < 0 || index >= boundaries.length - 1) {
		return null;
	}

	const sameMedia = job?.mediaId === mediaId && job.filePath === filePath;
	if (sameMedia && finished.has(index) && job && existsSync(segmentPath(job.dir, index))) {
		job.lastAccess = Date.now();
		job.lastRequested = index;
		return segmentPath(job.dir, index);
	}

	let current = await withJobLock(() =>
		needsRestart(job, mediaId, filePath, index) ? startJob(mediaId, filePath, index) : Promise.resolve(job as Job)
	);
	let retriedOnCpu = false;
	const deadline = Date.now() + SEGMENT_WAIT_MS;

	while (Date.now() < deadline) {
		current.lastAccess = Date.now();
		current.lastRequested = Math.max(current.start, index);
		if (current.paused) {
			current.process.kill("SIGCONT");
			current.paused = false;
		}
		await readFinished(current);
		if (finished.has(index)) {
			return segmentPath(current.dir, index);
		}
		if (current.exited && current.error) {
			// A hardware encoder can pass the test pattern and still fail on a real file; fall back once.
			if (current.encoder && current.encoder !== "libx264" && !retriedOnCpu) {
				console.warn(`[HLS] ${current.encoder} failed, retrying on the CPU`);
				retriedOnCpu = true;
				current = await withJobLock(() => startJob(mediaId, filePath, index, true));
				continue;
			}
			throw new Error(current.error);
		}
		if (current !== job) {
			// Another request moved ffmpeg elsewhere; this segment is no longer coming.
			return null;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return null;
}

/** Stop converting and drop the segments, e.g. on shutdown. */
export async function stopHls(): Promise<void> {
	if (job) {
		stopJob(job);
		job = null;
	}
	finished = new Set();
	await fs.rm(PATHS.hls, { recursive: true, force: true }).catch(() => undefined);
}
