import fs from "node:fs/promises";
import path from "node:path";
import type { Media } from "$lib/server/db/schema";
import type { SubtitleTrackResponse } from "$lib/types";
import { subtitlesDb } from "./db";
import { convertSubtitleToVtt, extractSubtitleToVtt, probeTextSubtitles } from "./ffmpeg";
import { sanitizeFilename } from "./images";
import { PATHS } from "./paths";

const SIDECAR_EXTENSIONS = [".srt", ".ass", ".ssa", ".vtt", ".sub"];

const LANGUAGE_MAP: Record<string, string> = {
	eng: "English",
	spa: "Spanish",
	fre: "French",
	fra: "French",
	ger: "German",
	deu: "German",
	ita: "Italian",
	por: "Portuguese",
	jpn: "Japanese",
	kor: "Korean",
	chi: "Chinese",
	zho: "Chinese",
	ara: "Arabic",
	rus: "Russian",
	hin: "Hindi",
	pol: "Polish",
	tur: "Turkish",
	nld: "Dutch",
	dut: "Dutch",
	swe: "Swedish",
	nor: "Norwegian",
	dan: "Danish",
	fin: "Finnish",
	und: "Unknown",
};

function parseLanguageFromFilename(fileName: string): { language: string; label: string } {
	const nameWithoutExt = fileName.slice(0, fileName.lastIndexOf("."));
	const parts = nameWithoutExt.split(".");
	const lastPart = parts.at(-1)?.toLowerCase() ?? "";
	if (LANGUAGE_MAP[lastPart]) {
		return { language: lastPart, label: LANGUAGE_MAP[lastPart] };
	}
	for (const [code, name] of Object.entries(LANGUAGE_MAP)) {
		if (lastPart === name.toLowerCase()) {
			return { language: code, label: name };
		}
	}
	if (parts.length >= 2) {
		const secondLast = parts.at(-2)?.toLowerCase() ?? "";
		for (const [code, name] of Object.entries(LANGUAGE_MAP)) {
			if (secondLast === code || secondLast === name.toLowerCase()) {
				return { language: code, label: name };
			}
		}
	}
	return { language: "und", label: "Unknown" };
}

function getSubtitleDir(mediaId: string): string {
	return path.join(PATHS.library, mediaId, "subtitles");
}

function isSubtitleFile(fileName: string): boolean {
	return SIDECAR_EXTENSIONS.includes(path.extname(fileName).toLowerCase());
}

async function discoverSidecarSubtitles(mediaId: string, libraryDir: string): Promise<void> {
	let files: string[];
	try {
		files = await fs.readdir(libraryDir);
	} catch {
		return;
	}
	let subtitleFiles = files.filter((fileName) => isSubtitleFile(fileName));
	if (subtitleFiles.length === 0) {
		return;
	}
	// Browsers only read WebVTT; keep the original next to it for external players.
	const vttNames = new Set(subtitleFiles.filter((name) => path.extname(name).toLowerCase() === ".vtt"));
	for (const fileName of subtitleFiles) {
		const extension = path.extname(fileName).toLowerCase();
		const vttName = `${fileName.slice(0, -extension.length)}.vtt`;
		if (extension === ".vtt" || extension === ".sub" || vttNames.has(vttName)) {
			continue;
		}
		try {
			await convertSubtitleToVtt(path.join(libraryDir, fileName), path.join(libraryDir, vttName));
			vttNames.add(vttName);
		} catch (error) {
			console.error(`[Subtitles] Failed to convert ${fileName} to WebVTT:`, error);
		}
	}
	subtitleFiles = [...new Set([...subtitleFiles, ...vttNames])];
	const existingPaths = new Set(subtitlesDb.getByMediaId(mediaId).map((subtitle) => subtitle.filePath));
	await fs.mkdir(getSubtitleDir(mediaId), { recursive: true });
	for (const fileName of subtitleFiles) {
		const sourcePath = path.join(libraryDir, fileName);
		if (existingPaths.has(sourcePath)) {
			continue;
		}
		if (path.extname(fileName).toLowerCase() !== ".vtt") {
			continue;
		}
		const { language, label } = parseLanguageFromFilename(fileName);
		subtitlesDb.create({
			mediaId,
			language,
			label,
			source: "sidecar",
			filePath: sourcePath,
		});
	}
}

export async function discoverSubtitles(mediaId: string, libraryDir: string): Promise<void> {
	await discoverSidecarSubtitles(mediaId, libraryDir);
}

// Media whose embedded tracks were already looked at in this process, so page loads do not re-probe.
const embeddedChecked = new Set<string>();

/** Pull text subtitle tracks out of the video into WebVTT files the browser player can load. */
export async function extractEmbeddedSubtitles(mediaId: string, videoPath: string): Promise<void> {
	if (embeddedChecked.has(mediaId)) {
		return;
	}
	embeddedChecked.add(mediaId);
	let tracks: Awaited<ReturnType<typeof probeTextSubtitles>>;
	try {
		tracks = await probeTextSubtitles(videoPath);
	} catch (error) {
		console.error(`[Subtitles] Failed to probe ${videoPath}:`, error);
		return;
	}
	if (tracks.length === 0) {
		return;
	}
	const dir = getSubtitleDir(sanitizeFilename(mediaId));
	await fs.mkdir(dir, { recursive: true });
	const existingPaths = new Set(subtitlesDb.getByMediaId(mediaId).map((subtitle) => subtitle.filePath));
	for (const track of tracks) {
		const outputPath = path.join(dir, `embedded-${track.subtitleIndex}.vtt`);
		if (existingPaths.has(outputPath)) {
			continue;
		}
		try {
			await extractSubtitleToVtt(videoPath, track.subtitleIndex, outputPath);
		} catch (error) {
			console.error(`[Subtitles] Failed to extract track ${track.subtitleIndex} of ${videoPath}:`, error);
			continue;
		}
		const languageName = LANGUAGE_MAP[track.language] ?? track.language;
		subtitlesDb.create({
			mediaId,
			language: track.language,
			label: track.title ? `${languageName} (${track.title})` : languageName,
			source: "embedded",
			filePath: outputPath,
		});
	}
}

function getSubtitleTracks(mediaId: string): SubtitleTrackResponse[] {
	return subtitlesDb.getByMediaId(mediaId).map((subtitle) => ({
		id: subtitle.id,
		mediaId: subtitle.mediaId,
		language: subtitle.language,
		label: subtitle.label,
		source: subtitle.source,
		src: `/api/media/${mediaId}/subtitles/${subtitle.id}`,
	}));
}
export async function getSubtitleTracksForMedia(
	media: Pick<Media, "id" | "filePath">
): Promise<SubtitleTrackResponse[]> {
	if (media.filePath) {
		await discoverSubtitles(media.id, path.dirname(media.filePath));
		await extractEmbeddedSubtitles(media.id, media.filePath);
	}
	return getSubtitleTracks(media.id);
}
