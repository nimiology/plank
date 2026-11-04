// Picks the H.264 encoder ffmpeg uses: a hardware one when it works on this machine, else libx264.

import { execFile, spawnSync } from "node:child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { env } from "$env/dynamic/private";

export const ENCODER_IDS = [
	"auto",
	"libx264",
	"h264_vaapi",
	"h264_qsv",
	"h264_nvenc",
	"h264_amf",
	"h264_videotoolbox",
] as const;
export type EncoderSetting = (typeof ENCODER_IDS)[number];
export type EncoderId = Exclude<EncoderSetting, "auto">;

export const ENCODER_LABELS: Record<EncoderSetting, string> = {
	auto: "Auto (best that works)",
	libx264: "CPU (libx264)",
	h264_vaapi: "Intel / AMD (VAAPI)",
	h264_qsv: "Intel Quick Sync (QSV)",
	h264_nvenc: "NVIDIA (NVENC)",
	h264_amf: "AMD (AMF)",
	h264_videotoolbox: "Apple (VideoToolbox)",
};

/** Hardware encoders in the order Auto tries them. */
const AUTO_ORDER: EncoderId[] = ["h264_nvenc", "h264_qsv", "h264_videotoolbox", "h264_vaapi", "h264_amf"];

const VAAPI_DEVICE = env.VAAPI_DEVICE || "/dev/dri/renderD128";

export function isEncoderSetting(value: unknown): value is EncoderSetting {
	return typeof value === "string" && (ENCODER_IDS as readonly string[]).includes(value);
}

/** A system ffmpeg is built with hardware encoders; the bundled static one usually is not. */
function resolveBinary(name: "ffmpeg" | "ffprobe", override: string | undefined, fallback: string | null): string {
	if (override) {
		return override;
	}
	const probe = spawnSync(name, ["-version"], { stdio: "ignore" });
	if (probe.status === 0) {
		return name;
	}
	return fallback ?? name;
}

export const FFMPEG_PATH = resolveBinary("ffmpeg", env.FFMPEG_PATH, ffmpegInstaller.path);
export const FFPROBE_PATH = resolveBinary("ffprobe", env.FFPROBE_PATH, null);

export interface EncodeOptions {
	/** Scale down to this height when the source is taller. */
	maxHeight?: number;
}

/** ffmpeg arguments for one encoder: input-side options, the video filter chain, and output options. */
export function getEncoderArgs(
	encoder: EncoderId,
	options: EncodeOptions = {}
): { input: string[]; filter: string; output: string[] } {
	const scale = options.maxHeight ? `scale=-2:'min(${options.maxHeight},ih)'` : null;
	const chain = (...steps: (string | null)[]) => steps.filter(Boolean).join(",");

	switch (encoder) {
		case "h264_vaapi":
			return {
				input: ["-vaapi_device", VAAPI_DEVICE],
				filter: chain(scale, "format=nv12", "hwupload"),
				output: ["-c:v", "h264_vaapi", "-qp", "23"],
			};
		case "h264_qsv":
			return {
				input: [],
				filter: chain(scale, "format=nv12"),
				output: ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "25"],
			};
		case "h264_nvenc":
			return {
				input: [],
				filter: chain(scale, "format=yuv420p"),
				output: ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23"],
			};
		case "h264_amf":
			return {
				input: [],
				filter: chain(scale, "format=nv12"),
				output: ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "23", "-qp_p", "23"],
			};
		case "h264_videotoolbox":
			return {
				input: [],
				filter: chain(scale, "format=nv12"),
				output: ["-c:v", "h264_videotoolbox", "-b:v", "6M", "-maxrate", "10M"],
			};
		default:
			return {
				input: [],
				filter: chain(scale, "format=yuv420p"),
				output: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"],
			};
	}
}

function run(args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
	return new Promise((resolve) => {
		execFile(FFMPEG_PATH, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
			resolve({ ok: !error, stdout: stdout ?? "" });
		});
	});
}

/** Encode one second of a test pattern; a listed encoder can still fail for lack of a device or driver. */
async function encoderWorks(encoder: EncoderId): Promise<boolean> {
	const { input, filter, output } = getEncoderArgs(encoder);
	const result = await run(
		[
			"-hide_banner",
			"-loglevel",
			"error",
			...input,
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=640x360:rate=30",
			"-t",
			"1",
			"-vf",
			filter,
			...output,
			"-f",
			"null",
			"-",
		],
		20_000
	);
	return result.ok;
}

export interface EncoderReport {
	ffmpegPath: string;
	/** Encoders ffmpeg was built with. */
	listed: EncoderId[];
	/** Encoders that passed a test encode. */
	working: EncoderId[];
	/** What Auto resolves to. */
	best: EncoderId;
}

let reportPromise: Promise<EncoderReport> | null = null;

async function buildReport(): Promise<EncoderReport> {
	const { stdout } = await run(["-hide_banner", "-encoders"], 10_000);
	const listed = (["libx264", ...AUTO_ORDER] as EncoderId[]).filter((id) => new RegExp(`\\s${id}\\s`).test(stdout));
	const working: EncoderId[] = [];
	for (const id of listed) {
		if (await encoderWorks(id)) {
			working.push(id);
		}
	}
	const best = AUTO_ORDER.find((id) => working.includes(id)) ?? "libx264";
	console.log(`[Encoder] ffmpeg=${FFMPEG_PATH} working=[${working.join(", ")}] auto=${best}`);
	return { ffmpegPath: FFMPEG_PATH, listed, working, best };
}

/** Detection runs once per process; pass refresh to run it again (e.g. after a driver install). */
export function detectEncoders(refresh = false): Promise<EncoderReport> {
	if (refresh || !reportPromise) {
		reportPromise = buildReport();
	}
	return reportPromise;
}

/** Turn the saved setting into a concrete encoder. A chosen encoder that fails its test falls back to Auto. */
export async function resolveEncoder(setting: EncoderSetting): Promise<EncoderId> {
	const report = await detectEncoders();
	if (setting !== "auto" && report.working.includes(setting)) {
		return setting;
	}
	if (setting !== "auto") {
		console.warn(`[Encoder] ${setting} is not working on this machine, using ${report.best}`);
	}
	return report.best;
}
