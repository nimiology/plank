// Builds deterministic library filenames and resolves stable library paths
// for movies, shows, seasons, and episodes.
// FEATURE: Shared filesystem layout for media storage, naming, and cleanup behavior

import path from "node:path";
import { env } from "$env/dynamic/private";
import { mediaDb } from "./db";

// --- Filename building ---
// TODO: Implement some directory traversal stops

// Matches < > : \ / ? " * |
const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*]/g;
const WHITESPACE_PATTERN = /\s+/g;
const TRAILING_DOTS_AND_SPACES = /[.\s]+$/g;

function stripControlCharacters(value: string): string {
	return Array.from(value)
		.filter((character) => character.charCodeAt(0) >= 32)
		.join("");
}

function sanitizeFileSegment(value: string, fallback: string): string {
	const sanitized = value.replace(INVALID_FILENAME_CHARACTERS, " ").trim();
	const cleaned = stripControlCharacters(sanitized)
		.replace(WHITESPACE_PATTERN, " ")
		.replace(TRAILING_DOTS_AND_SPACES, "")
		.trim();
	return cleaned || fallback;
}

function getSafeExtension(sourceFileName: string): string {
	const extension = path.extname(sourceFileName).trim();
	return extension || ".mp4";
}

export function buildMovieFileName(media: { title: string; year: number | null }, sourceFileName: string): string {
	const title = sanitizeFileSegment(media.title, "Unknown Movie");
	const extension = getSafeExtension(sourceFileName);
	if (media.year) {
		return `${title} (${media.year})${extension}`;
	}
	return `${title}${extension}`;
}

export function buildMovieLibraryDirectoryName(movie: { title: string; year: number | null; id?: string }): string {
	const title = sanitizeFileSegment(movie.title, movie.id ?? "Unknown Movie");
	if (movie.year) {
		return `${title} (${movie.year})`;
	}
	return title;
}

export function buildShowLibraryDirectoryName(show: { title: string; year: number | null; id?: string }): string {
	const title = sanitizeFileSegment(show.title, show.id ?? "Unknown Show");
	if (show.year) {
		return `${title} (${show.year})`;
	}
	return title;
}

export function buildEpisodeFileName(
	showTitle: string,
	episode: { seasonNumber: number | null; episodeNumber: number | null; title: string },
	sourceFileName: string
): string {
	const show = sanitizeFileSegment(showTitle, "Unknown Show");
	const seasonNumber = String(episode.seasonNumber ?? 0).padStart(2, "0");
	const episodeNumber = String(episode.episodeNumber ?? 0).padStart(2, "0");
	const title = sanitizeFileSegment(episode.title, `Episode ${episodeNumber}`);
	const extension = getSafeExtension(sourceFileName);
	return `${show} - S${seasonNumber}E${episodeNumber} - ${title}${extension}`;
}

// --- Library path resolution ---

interface MovieDirectoryMedia {
	id: string;
	title: string;
	year: number | null;
	filePath?: string | null;
}

interface ShowDirectoryMedia {
	id: string;
	title: string;
	year: number | null;
}

interface EpisodeDirectoryMedia {
	title: string;
	seasonNumber: number | null;
	episodeNumber: number | null;
}

function getExistingShowLibraryRoot(showId: string): string | null {
	const existingEpisode = mediaDb.getEpisodesByParentId(showId).find((episode) => episode.filePath);
	if (!existingEpisode?.filePath) {
		return null;
	}
	return path.dirname(path.dirname(existingEpisode.filePath));
}

// Gets the OS path to the media requested by the provided filePath or building it with the configured library path + the media name.
export function getMovieLibraryRoot(movie: MovieDirectoryMedia): string {
	if (movie.filePath) {
		return path.dirname(movie.filePath);
	}
	return path.join(PATHS.library, buildMovieLibraryDirectoryName(movie));
}

export function getMovieLibraryDirectoryId(movie: MovieDirectoryMedia): string {
	return path.basename(getMovieLibraryRoot(movie));
}

export function getShowLibraryRoot(show: ShowDirectoryMedia): string {
	return getExistingShowLibraryRoot(show.id) ?? path.join(PATHS.library, buildShowLibraryDirectoryName(show));
}

export function getShowLibraryDirectoryId(show: ShowDirectoryMedia): string {
	return path.basename(getShowLibraryRoot(show));
}

export function getSeasonLibraryDirectory(show: ShowDirectoryMedia, seasonNumber: number | null): string {
	return path.join(getShowLibraryRoot(show), `Season ${String(seasonNumber ?? 0).padStart(2, "0")}`);
}

export function getEpisodeLibraryPath(
	show: ShowDirectoryMedia,
	episode: EpisodeDirectoryMedia,
	sourceFileName: string
): string {
	return path.join(
		getSeasonLibraryDirectory(show, episode.seasonNumber),
		buildEpisodeFileName(show.title, episode, sourceFileName)
	);
}

// Paths value constants
export const PATHS = {
	data: env.DATA_PATH || "./data",
	get library() {
		return `${this.data}/library`;
	},
	get temp() {
		return `${this.data}/temp`;
	},
	/** Live-converted HLS segments; outside temp so its cleanup job leaves a playing stream alone. */
	get hls() {
		return `${this.data}/hls`;
	},
};
