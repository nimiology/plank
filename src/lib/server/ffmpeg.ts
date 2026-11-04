import { execFile } from "node:child_process";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import ffmpeg from "fluent-ffmpeg";
import { FFMPEG_PATH, FFPROBE_PATH, getEncoderArgs, resolveEncoder } from "./encoder";
import { getSettings } from "./settings";

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

// Supported video containers that browsers can play natively
const NATIVE_PLAYABLE = [".mp4", ".webm"];

// Supported containers that need transmuxing (container change, no re-encoding)
const TRANSMUXABLE = [".mkv", ".avi", ".mov", ".m4v"];

// All supported video formats
export const SUPPORTED_VIDEO_FORMATS = [...NATIVE_PLAYABLE, ...TRANSMUXABLE];

export function needsTransmux(fileName: string): boolean {
	const ext = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
	return TRANSMUXABLE.includes(ext);
}

export function isSupportedFormat(fileName: string): boolean {
	const ext = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
	return SUPPORTED_VIDEO_FORMATS.includes(ext);
}

interface TransmuxOptions {
	inputStream: Readable;
	start?: number;
	fileName?: string;
	onError?: (err: Error) => void;
}

const BROWSER_SAFE_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1"]);
const BROWSER_SAFE_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis"]);

// Copy only audio that is suitable for MP4 and already meets our channel limit.
const MP4_COPY_AUDIO_CODECS = new Set(["aac", "mp3"]);

function getAudioOutputOptions({ audioCodec, audioChannels }: PlaybackCompatibility): string[] {
	if (
		audioCodec !== null &&
		MP4_COPY_AUDIO_CODECS.has(audioCodec) &&
		audioChannels !== null &&
		audioChannels > 0 &&
		audioChannels <= 2
	) {
		return ["-c:a", "copy"];
	}
	return ["-c:a", "aac", "-ac", "2", "-b:a", "192k"];
}

const INPUT_FORMAT_BY_EXTENSION: Record<string, string> = {
	".avi": "avi",
	".m4v": "mp4",
	".mkv": "matroska",
	".mov": "mov",
	".mp4": "mp4",
	".webm": "webm",
};

function getInputFormat(fileName?: string): string | null {
	if (!fileName) {
		return null;
	}
	const extension = fileName.toLowerCase().slice(fileName.lastIndexOf("."));
	return INPUT_FORMAT_BY_EXTENSION[extension] ?? null;
}

function isIgnorableTextDataStream(stream: {
	codec_type?: string;
	codec_name?: string;
	codec_tag_string?: string;
	tags?: { handler_name?: string };
}): boolean {
	return (
		stream.codec_type === "data" &&
		stream.codec_name === "bin_data" &&
		stream.codec_tag_string === "text" &&
		stream.tags?.handler_name === "SubtitleHandler"
	);
}

export function createTransmuxStream(options: TransmuxOptions): Readable {
	const { inputStream, start, fileName, onError } = options;
	const outputStream = new PassThrough();
	const command = ffmpeg(inputStream)
		.outputFormat("mp4")
		.inputOptions(["-fflags", "+genpts", "-analyzeduration", "5M", "-probesize", "5M"])
		.outputOptions([
			"-map_metadata",
			"-1",
			"-map_chapters",
			"-1",
			"-map",
			"0:v:0",
			"-map",
			"0:a:0?",
			"-dn",
			"-sn",
			"-movflags",
			// Fragmented output can stream to a pipe; faststart is for seekable files.
			"frag_keyframe+empty_moov+default_base_moof",
			"-c:v",
			"copy", // Copy video stream (no re-encoding)
			"-c:a",
			"aac", // Transcode audio to AAC for browser compatibility
			"-ac",
			"2",
			"-b:a",
			"192k",
		]);

	const inputFormat = getInputFormat(fileName);
	if (inputFormat) {
		command.inputFormat(inputFormat);
	}

	if (start && start > 0) {
		command.setStartTime(start);
	}

	command
		// .on('start', (cmd) => {
		// 	console.log('[Transcoder] Starting FFmpeg:', cmd);
		// })
		.on("error", (err: Error, _stdout, stderr) => {
			console.error("[Transcoder] FFmpeg error:", err.message);
			if (stderr) {
				console.error("[Transcoder] FFmpeg stderr:", stderr);
			}
			if (onError) {
				onError(err);
			}
			outputStream.destroy(err);
		})
		// .on('end', () => {
		// 	console.log('[Transcoder] FFmpeg finished');
		// })
		.pipe(outputStream, { end: true });

	return outputStream;
}

/**
 * Transmux a file from one format to another (typically MKV to MP4)
 */
export async function transmuxFile(inputPath: string, outputPath: string): Promise<void> {
	const compatibility = await getPlaybackCompatibility(inputPath);
	return new Promise((resolve, reject) => {
		ffmpeg(inputPath)
			.output(outputPath)
			.outputOptions([
				"-map_metadata",
				"-1",
				"-map_chapters",
				"-1",
				"-map",
				"0:v:0",
				"-map",
				"0:a:0?",
				"-dn",
				"-sn",
				"-movflags",
				"+faststart", // Optimize for web streaming
				"-c:v",
				"copy", // Copy video stream (no re-encoding)
				...getAudioOutputOptions(compatibility),
			])
			.on("error", (err: Error) => {
				console.error("[Transcoder] Transmux error:", err.message);
				reject(err);
			})
			.on("end", () => {
				resolve();
			})
			.run();
	});
}

export async function convertSubtitleToVtt(inputPath: string, outputPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		ffmpeg(inputPath)
			.outputOptions(["-c:s", "webvtt"])
			.output(outputPath)
			.on("error", (err: Error) => {
				reject(err);
			})
			.on("end", () => {
				resolve();
			})
			.run();
	});
}

/** Subtitle formats that convert to WebVTT. Picture-based ones (PGS, VobSub) need OCR, so they are skipped. */
const TEXT_SUBTITLE_CODECS = new Set(["subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"]);

export interface EmbeddedSubtitle {
	/** Position among the file's subtitle streams, for `-map 0:s:N`. */
	subtitleIndex: number;
	language: string;
	title: string | null;
}

export function probeTextSubtitles(filePath: string): Promise<EmbeddedSubtitle[]> {
	return new Promise((resolve, reject) => {
		ffmpeg.ffprobe(filePath, (err, metadata) => {
			if (err) {
				reject(err);
				return;
			}
			const subtitles = metadata.streams.filter((stream) => stream.codec_type === "subtitle");
			resolve(
				subtitles.flatMap((stream, subtitleIndex) =>
					TEXT_SUBTITLE_CODECS.has(stream.codec_name ?? "")
						? [
								{
									subtitleIndex,
									language: (stream.tags?.language as string | undefined) || "und",
									title: (stream.tags?.title as string | undefined) || null,
								},
							]
						: []
				)
			);
		});
	});
}

/**
 * Write several subtitle tracks to WebVTT in one read of the file, at low CPU priority:
 * a file can carry 20+ tracks, and one pass per track would read the whole video each time.
 */
export function extractSubtitlesToVtt(
	inputPath: string,
	tracks: { subtitleIndex: number; outputPath: string }[]
): Promise<void> {
	const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", inputPath];
	for (const track of tracks) {
		args.push("-map", `0:s:${track.subtitleIndex}`, "-c:s", "webvtt", track.outputPath);
	}
	return new Promise((resolve, reject) => {
		execFile(
			"nice",
			["-n", "15", FFMPEG_PATH, ...args],
			{ maxBuffer: 4 * 1024 * 1024 },
			(error, _stdout, stderr) => {
				if (error) {
					reject(new Error(stderr.trim() || error.message));
					return;
				}
				resolve();
			}
		);
	});
}

// Probe a file to get its codec information
export async function probeFile(filePath: string): Promise<{
	videoCodec: string | null;
	audioCodec: string | null;
	duration: number | null;
	audioChannels: number | null;
	hasDataStreams: boolean;
	videoHeight?: number | null;
	pixelFormat?: string | null;
}> {
	return new Promise((resolve, reject) => {
		ffmpeg.ffprobe(filePath, (err, metadata) => {
			if (err) {
				reject(err);
				return;
			}

			const videoStream = metadata.streams.find((s) => s.codec_type === "video");
			const audioStream = metadata.streams.find((s) => s.codec_type === "audio");
			const hasDataStreams = metadata.streams.some(
				(stream) => stream.codec_type === "data" && !isIgnorableTextDataStream(stream)
			);

			resolve({
				videoCodec: videoStream?.codec_name || null,
				audioCodec: audioStream?.codec_name || null,
				duration: metadata.format.duration || null,
				audioChannels: audioStream?.channels || null,
				hasDataStreams,
				videoHeight: videoStream?.height || null,
				pixelFormat: videoStream?.pix_fmt || null,
			});
		});
	});
}

export interface PlaybackCompatibility {
	audioCodec: string | null;
	audioChannels: number | null;
	needsVideoTranscode: boolean;
	requiresNormalization: boolean;
}

export async function getPlaybackCompatibility(filePath: string): Promise<PlaybackCompatibility> {
	const probe = await probeFile(filePath);
	const needsVideoTranscode = !(probe.videoCodec && BROWSER_SAFE_VIDEO_CODECS.has(probe.videoCodec));
	const needsAudioNormalization =
		(probe.audioCodec !== null && !BROWSER_SAFE_AUDIO_CODECS.has(probe.audioCodec)) ||
		(probe.audioChannels ?? 0) > 2;
	const needsDataCleanup = probe.hasDataStreams;
	return {
		audioCodec: probe.audioCodec,
		audioChannels: probe.audioChannels,
		needsVideoTranscode,
		requiresNormalization: needsVideoTranscode || needsAudioNormalization || needsDataCleanup,
	};
}

export async function requiresBrowserSafePlayback(filePath: string): Promise<boolean> {
	return (await getPlaybackCompatibility(filePath)).requiresNormalization;
}

export async function normalizeFileForPlayback(
	inputPath: string,
	outputPath: string,
	onProgress?: (progress: number) => void
): Promise<void> {
	const compatibility = await getPlaybackCompatibility(inputPath);
	const encoder = compatibility.needsVideoTranscode
		? getEncoderArgs(await resolveEncoder((await getSettings()).playback.encoder), { maxHeight: 1080 })
		: null;
	return new Promise((resolve, reject) => {
		const command = ffmpeg(inputPath)
			.output(outputPath)
			.outputOptions([
				"-map_metadata",
				"-1",
				"-map_chapters",
				"-1",
				"-map",
				"0:v:0",
				"-map",
				"0:a:0?",
				"-dn",
				"-sn",
				"-movflags",
				"+faststart",
				...getAudioOutputOptions(compatibility),
			]);

		if (encoder) {
			command.inputOptions(encoder.input).outputOptions(["-vf", encoder.filter, ...encoder.output]);
		} else {
			command.outputOptions(["-c:v", "copy"]);
		}

		if (onProgress) {
			command.on("progress", (progress) => {
				const percent = progress.percent;
				if (percent === undefined || !Number.isFinite(percent)) {
					return;
				}
				onProgress(Math.min(1, Math.max(0, percent / 100)));
			});
		}

		command
			.on("error", (err: Error) => {
				console.error("[Transcoder] Normalize error:", err.message);
				reject(err);
			})
			.on("end", () => {
				resolve();
			})
			.run();
	});
}
