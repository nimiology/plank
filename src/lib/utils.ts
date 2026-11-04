import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Media } from "$lib/types";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

const TMDB_IMAGE_PREFIX = "https://image.tmdb.org/t/p/";

/** Serve TMDB posters through plank, so viewers whose network blocks image.tmdb.org still see them. */
export function tmdbImage(url: string | null): string | null {
	return url?.startsWith(TMDB_IMAGE_PREFIX) ? `/api/tmdb-image/${url.slice(TMDB_IMAGE_PREFIX.length)}` : url;
}

export function canPlayEpisode(episode: Pick<Media, "filePath" | "fileIndex" | "status">): boolean {
	return Boolean(
		episode.filePath ||
			episode.fileIndex !== null ||
			episode.status === "complete" ||
			episode.status === "downloading"
	);
}

export function isTerminalProgressStatus(status: string | null | undefined): boolean {
	return status === "complete" || status === "error" || status === "not_found" || status === "removed";
}

/** Fail loudly on a broken invariant. Never use this for input the user controls. */
export function assert(condition: boolean, message: string): asserts condition {
	if (!condition) {
		throw new Error(`assertion failed: ${message}`);
	}
}

const BYTES_PER_UNIT = 1024;
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const SIZE_DECIMALS = [0, 1, 1, 2, 2] as const;

/** Format a byte count for display. The count must be finite and not negative. */
export function formatFileSize(bytes: number): string {
	assert(Number.isFinite(bytes), `formatFileSize: bytes must be finite, got ${bytes}`);
	assert(bytes >= 0, `formatFileSize: bytes must not be negative, got ${bytes}`);

	let value = bytes;
	let unit = 0;
	while (value >= BYTES_PER_UNIT && unit < SIZE_UNITS.length - 1) {
		value /= BYTES_PER_UNIT;
		unit += 1;
	}

	return `${value.toFixed(SIZE_DECIMALS[unit])} ${SIZE_UNITS[unit]}`;
}
