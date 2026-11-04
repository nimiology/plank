import fs from "node:fs/promises";
import path from "node:path";
import type { OpenSubtitleResult } from "$lib/types";
import { sanitizeFilename } from "./images";
import { PATHS } from "./paths";
import { getSettings } from "./settings";

const BASE_URL = "https://api.opensubtitles.com/api/v1";
const USER_AGENT = "plank-media v0.1.0";
const IMDB_PREFIX_REGEX = /^tt/;

// ============================================================================
// Types
// ============================================================================

interface OpenSubtitlesSearchParams {
	tmdbId?: number;
	imdbId?: string;
	parentTmdbId?: number;
	parentImdbId?: string;
	query?: string;
	year?: number;
	seasonNumber?: number;
	episodeNumber?: number;
	languages?: string; // comma-separated ISO 639-1 codes (e.g. "en,es,fr")
}

interface OSAttributes {
	language: string;
	download_count: number;
	hearing_impaired: boolean;
	fps: number;
	ratings: number;
	from_trusted: boolean;
	ai_translated: boolean;
	release: string;
	files: Array<{
		file_id: number;
		file_name: string;
	}>;
}

interface OSSearchResponse {
	data: Array<{
		id: string;
		attributes: OSAttributes;
	}>;
}

interface OSDownloadResponse {
	link: string;
	file_name: string;
}

interface OSLoginResponse {
	token: string;
}

// ISO 639-1 to language name mapping for display
const LANGUAGE_NAMES: Record<string, string> = {
	fa: "Persian",
	en: "English",
	es: "Spanish",
	fr: "French",
	de: "German",
	it: "Italian",
	pt: "Portuguese",
	ja: "Japanese",
	ko: "Korean",
	zh: "Chinese",
	ar: "Arabic",
	ru: "Russian",
	hi: "Hindi",
	pl: "Polish",
	tr: "Turkish",
	nl: "Dutch",
	sv: "Swedish",
	no: "Norwegian",
	da: "Danish",
	fi: "Finnish",
	cs: "Czech",
	ro: "Romanian",
	hu: "Hungarian",
	el: "Greek",
	he: "Hebrew",
	th: "Thai",
	vi: "Vietnamese",
	id: "Indonesian",
	ms: "Malay",
	uk: "Ukrainian",
	bg: "Bulgarian",
	hr: "Croatian",
	sr: "Serbian",
	sk: "Slovak",
	sl: "Slovenian",
};

// ISO 639-1 to ISO 639-2/B mapping for DB storage (matching existing LANGUAGE_MAP in subtitles.ts)
const ISO1_TO_ISO2: Record<string, string> = {
	en: "eng",
	es: "spa",
	fr: "fre",
	de: "ger",
	it: "ita",
	pt: "por",
	ja: "jpn",
	ko: "kor",
	zh: "chi",
	ar: "ara",
	ru: "rus",
	hi: "hin",
	pl: "pol",
	tr: "tur",
	nl: "nld",
	sv: "swe",
	no: "nor",
	da: "dan",
	fi: "fin",
	cs: "ces",
	ro: "ron",
	hu: "hun",
	el: "ell",
	he: "heb",
	th: "tha",
	vi: "vie",
	id: "ind",
	ms: "msa",
	uk: "ukr",
	bg: "bul",
	hr: "hrv",
	sr: "srp",
	sk: "slk",
	sl: "slv",
};

export function getLanguageName(code: string): string {
	return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

export function getIso2Code(iso1Code: string): string {
	return ISO1_TO_ISO2[iso1Code] ?? iso1Code;
}

async function getApiKey(): Promise<string> {
	const settings = await getSettings();
	return settings.opensubtitles.apiKey;
}

async function getCredentials(): Promise<{ username: string; password: string }> {
	const settings = await getSettings();
	return {
		username: settings.opensubtitles.username,
		password: settings.opensubtitles.password,
	};
}

let cachedToken: string | null = null;
let tokenExpiry = 0;

function buildHeaders(apiKey: string, token?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"Api-Key": apiKey,
		"User-Agent": USER_AGENT,
	};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

async function login(apiKey: string): Promise<string> {
	const { username, password } = await getCredentials();
	if (!(username && password)) {
		throw new Error("OpenSubtitles credentials not configured");
	}

	const response = await fetch(`${BASE_URL}/login`, {
		method: "POST",
		headers: buildHeaders(apiKey),
		body: JSON.stringify({ username, password }),
	});

	if (!response.ok) {
		const text = await response.text();
		console.error(`[OpenSubtitles] Login failed: ${response.status} ${text}`);
		throw new Error(`OpenSubtitles login failed: ${response.status}`);
	}

	const data: OSLoginResponse = await response.json();
	cachedToken = data.token;
	tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
	return data.token;
}

async function getValidToken(apiKey: string): Promise<string | null> {
	const { username, password } = await getCredentials();
	if (!(username && password)) {
		return null;
	}

	if (cachedToken && Date.now() < tokenExpiry) {
		return cachedToken;
	}

	return login(apiKey);
}

// ============================================================================
// Search
// ============================================================================

export async function searchSubtitles(params: OpenSubtitlesSearchParams): Promise<OpenSubtitleResult[]> {
	const apiKey = await getApiKey();
	if (!apiKey) {
		throw new Error("OpenSubtitles API key not configured");
	}

	const searchParams = new URLSearchParams();

	if (params.tmdbId) {
		searchParams.set("tmdb_id", String(params.tmdbId));
	}
	if (params.imdbId) {
		// OpenSubtitles expects numeric IMDB ID without "tt" prefix
		const numericId = params.imdbId.replace(IMDB_PREFIX_REGEX, "");
		searchParams.set("imdb_id", numericId);
	}
	if (params.parentTmdbId) {
		searchParams.set("parent_tmdb_id", String(params.parentTmdbId));
	}
	if (params.parentImdbId) {
		searchParams.set("parent_imdb_id", params.parentImdbId.replace(IMDB_PREFIX_REGEX, ""));
	}
	if (params.query) {
		searchParams.set("query", params.query);
	}
	if (params.year) {
		searchParams.set("year", String(params.year));
	}
	if (typeof params.seasonNumber === "number" && Number.isFinite(params.seasonNumber)) {
		searchParams.set("season_number", String(params.seasonNumber));
	}
	if (typeof params.episodeNumber === "number" && Number.isFinite(params.episodeNumber)) {
		searchParams.set("episode_number", String(params.episodeNumber));
	}
	if (params.languages) {
		searchParams.set("languages", params.languages);
	}

	// Sort by download count to get best results first
	searchParams.set("order_by", "download_count");
	searchParams.set("order_direction", "desc");

	const url = `${BASE_URL}/subtitles?${searchParams.toString()}`;

	const response = await fetch(url, {
		headers: buildHeaders(apiKey),
	});

	if (!response.ok) {
		const text = await response.text();
		console.error(`[OpenSubtitles] Search failed: ${response.status} ${text}`);
		throw new Error(`OpenSubtitles search failed: ${response.status}`);
	}

	const data: OSSearchResponse = await response.json();

	return data.data.map((item) => {
		const attr = item.attributes;
		const file = attr.files[0];

		return {
			id: item.id,
			fileId: file?.file_id ?? 0,
			fileName: file?.file_name ?? "unknown",
			language: attr.language,
			languageName: getLanguageName(attr.language),
			release: attr.release,
			downloadCount: attr.download_count,
			hearingImpaired: attr.hearing_impaired,
			aiTranslated: attr.ai_translated,
			fromTrusted: attr.from_trusted,
			fps: attr.fps,
			ratings: attr.ratings,
		};
	});
}

// ============================================================================
// Download
// ============================================================================

/** UTF-8 when valid, otherwise Windows-1256, the legacy encoding most older Persian and Arabic subtitles use. */
export function decodeSubtitle(bytes: ArrayBuffer): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder("windows-1256").decode(bytes);
	}
}

export async function downloadSubtitle(fileId: number, mediaId: string): Promise<{ filePath: string }> {
	const apiKey = await getApiKey();
	if (!apiKey) {
		throw new Error("OpenSubtitles API key not configured");
	}

	const token = await getValidToken(apiKey);

	const response = await fetch(`${BASE_URL}/download`, {
		method: "POST",
		headers: buildHeaders(apiKey, token ?? undefined),
		body: JSON.stringify({ file_id: fileId }),
	});

	if (!response.ok) {
		const text = await response.text();
		console.error(`[OpenSubtitles] Download request failed: ${response.status} ${text}`);
		throw new Error(`OpenSubtitles download failed: ${response.status}`);
	}

	const downloadInfo: OSDownloadResponse = await response.json();

	// Step 2: Fetch the actual subtitle file
	const fileResponse = await fetch(downloadInfo.link);
	if (!fileResponse.ok) {
		throw new Error(`Failed to download subtitle file: ${fileResponse.status}`);
	}

	const content = decodeSubtitle(await fileResponse.arrayBuffer());

	// Step 3: Save to disk
	const subtitleDir = path.join(PATHS.library, sanitizeFilename(mediaId), "subtitles");
	await fs.mkdir(subtitleDir, { recursive: true });

	// Use a unique filename based on the original plus a timestamp
	const baseName = path.basename(downloadInfo.file_name, path.extname(downloadInfo.file_name));
	const safeName = sanitizeFilename(baseName);
	const fileName = `${safeName}_${Date.now()}.srt`;
	const filePath = path.join(subtitleDir, fileName);

	await fs.writeFile(filePath, content, "utf-8");

	// Step 4: Convert to VTT if needed (SRT is most common from OpenSubtitles)
	const { convertSubtitleToVtt } = await import("./ffmpeg");
	const vttFileName = `${safeName}_${Date.now()}.vtt`;
	const vttPath = path.join(subtitleDir, vttFileName);

	try {
		await convertSubtitleToVtt(filePath, vttPath);
		// Clean up the original SRT
		await fs.unlink(filePath).catch(() => undefined);
		return { filePath: vttPath };
	} catch {
		// If conversion fails, try serving the SRT directly
		console.error("[OpenSubtitles] VTT conversion failed, keeping SRT");
		return { filePath };
	}
}
