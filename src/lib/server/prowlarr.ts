/**
 * Prowlarr API Client
 *
 * Searches for torrents across multiple indexers via Prowlarr.
 * Filters for high-quality releases from trusted groups.
 */

import parseTorrent from "parse-torrent";
import { getSettings } from "$lib/server/settings";

/**
 * Standardized Indexer search result
 */
export interface IndexerResult {
	title: string;
	magnetUri: string;
	infohash: string;
	size: number;
	seeders: number;
	indexer: string;
}

/**
 * Raw Prowlarr API response item
 */
interface ProwlarrResultItem {
	title: string;
	magnetUrl?: string;
	downloadUrl?: string;
	infoHash?: string;
	size: number;
	seeders?: number;
	indexer?: string;
}

/**
 * Quality patterns to reject (low quality releases)
 */
const LOW_QUALITY_PATTERNS = [
	/\bCAM\b/i,
	/\bHDCAM\b/i,
	/\bTS\b/i,
	/\bTELESYNC\b/i,
	/\bHDTS\b/i,
	/\bSCR\b/i,
	/\bSCREENER\b/i,
	/\bDVDSCR\b/i,
	/\bR5\b/i,
	/\bTC\b/i,
	/\bTELECINE\b/i,
];

/**
 * Quality scoring for sorting (higher is better)
 * Keys are uppercase to match extractQuality output
 */
const QUALITY_SCORES: Record<string, number> = {
	"1080P": 100,
	"2160P": 85,
	UHD: 80,
	"720P": 60,
	"4K": 40,
};

/**
 * Pattern to extract quality from title
 */
const QUALITY_PATTERN = /\b(2160p|4K|UHD|1080p|720p|480p)\b/i;
const INDEXER_PREFERENCE_SCORES: Record<string, number> = {
	"1337x": 3,
	YTS: 2,
	"The Pirate Bay": 1,
};

const TV_SEARCH_CATEGORY = "5000";

/**
 * Parse Prowlarr API response into typed results
 * Accepts both magnet links and HTTP download URLs (which will be resolved later)
 */
export function parseProwlarrResults(results: ProwlarrResultItem[]): IndexerResult[] {
	if (!Array.isArray(results)) {
		return [];
	}

	return results
		.filter((r) => {
			// Accept magnetUrl, or downloadUrl (either magnet: or http: - we'll resolve HTTP later)
			const hasLink = r.magnetUrl || r.downloadUrl;
			// infoHash is required for deduplication and identification
			return hasLink && r.infoHash;
		})
		.map((r) => ({
			title: r.title,
			// Prefer magnetUrl, fall back to downloadUrl (which may be HTTP and resolved later)
			magnetUri: (r.magnetUrl || r.downloadUrl) as string,
			infohash: (r.infoHash as string).toLowerCase(),
			size: r.size,
			seeders: r.seeders || 0,
			indexer: r.indexer || "Unknown",
		}));
}

/**
 * Filter results by trusted release groups
 */
export function filterByReleaseGroup(results: IndexerResult[], trustedGroups: string[]): IndexerResult[] {
	if (trustedGroups.length === 0) {
		return results;
	}

	return results.filter((result) => {
		const title = result.title.toUpperCase();
		return trustedGroups.some((group) => title.includes(group.toUpperCase()));
	});
}

/**
 * Filter out low quality releases (CAM, TS, etc.)
 */
export function filterByQuality(results: IndexerResult[]): IndexerResult[] {
	return results.filter((result) => {
		return !LOW_QUALITY_PATTERNS.some((pattern) => pattern.test(result.title));
	});
}

/**
 * Extract quality from title (e.g., "1080p", "2160p")
 */
function extractQuality(title: string): string | null {
	const match = title.match(QUALITY_PATTERN);
	return match ? match[1].toUpperCase() : null;
}

/**
 * Calculate score for a torrent result
 * Considers quality, seeders, and source preference
 */
function calculateScore(result: IndexerResult): number {
	const quality = extractQuality(result.title);
	const qualityScore = quality ? QUALITY_SCORES[quality] || 0 : 0;

	// Seeders score (logarithmic to not overweight very high seeder counts)
	const seederScore = Math.log10(result.seeders + 1) * 20;
	const indexerScore = INDEXER_PREFERENCE_SCORES[result.indexer] ?? 0;

	return qualityScore + seederScore + indexerScore;
}

/**
 * Select the best torrent from results
 * Prioritizes quality and seeders
 */
export function selectBestTorrent(results: IndexerResult[]): IndexerResult | null {
	if (results.length === 0) {
		return null;
	}

	// Sort by score descending
	const sorted = [...results].sort((a, b) => {
		const scoreA = calculateScore(a);
		const scoreB = calculateScore(b);
		return scoreB - scoreA;
	});

	return sorted[0];
}

/**
 * Check if hostname is localhost
 */
function isLocalhost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * Try to extract magnet from response body (torrent file or text)
 */
function extractMagnetFromBody(buffer: ArrayBuffer, contentType: string): string | null {
	// Check if it's a torrent file
	if (contentType.includes("torrent") || contentType.includes("octet-stream")) {
		const parsed = parseTorrent(Buffer.from(buffer));
		if (parsed?.infoHash) {
			// @ts-expect-error - types missing for toMagnetURI
			return parseTorrent.toMagnetURI(parsed);
		}
	}

	// Check if the body itself is a magnet link (text response)
	if (buffer.byteLength < 1000) {
		const text = new TextDecoder().decode(buffer).trim();
		if (text.startsWith("magnet:")) {
			return text;
		}
	}

	return null;
}

/**
 * Handle redirect response, returning magnet link or recursively following HTTP redirects
 */
async function handleRedirect(
	response: Response,
	tryFetch: (url: string) => Promise<string | null>
): Promise<string | null> {
	const location = response.headers.get("location");
	if (!location) {
		return null;
	}

	if (location.startsWith("magnet:")) {
		return location;
	}

	if (location.startsWith("http")) {
		return tryFetch(location);
	}

	return null;
}

/**
 * Attempt to fetch and resolve a magnet link from a URL
 */
async function tryFetchMagnet(fetchUrl: string): Promise<string | null> {
	try {
		// Use redirect: 'manual' to capture magnet: redirects (Node's fetch can't follow non-HTTP)
		const response = await fetch(fetchUrl, {
			redirect: "manual",
			headers: { "User-Agent": "Plank/1.0" },
		});

		// Handle redirects (3xx status)
		const isRedirect = response.status >= 300 && response.status < 400;
		if (isRedirect) {
			return handleRedirect(response, tryFetchMagnet);
		}

		if (!response.ok) {
			return null;
		}

		// Parse response body for magnet
		const contentType = response.headers.get("content-type") || "";
		const buffer = await response.arrayBuffer();
		return extractMagnetFromBody(buffer, contentType);
	} catch {
		return null;
	}
}

/**
 * Remove the Prowlarr API key from a download link.
 * Links leave the server without the key, so a browser never holds it.
 */
function stripApiKey(url: string): string {
	if (!url.startsWith("http")) {
		return url;
	}
	try {
		const target = new URL(url);
		target.searchParams.delete("apikey");
		return target.toString();
	} catch {
		return url;
	}
}

/**
 * Put the Prowlarr API key back on a download link before the server fetches it.
 * Only links to the configured Prowlarr host get the key.
 */
async function addApiKey(url: string): Promise<string> {
	try {
		const settings = await getSettings();
		const target = new URL(url);
		const configured = new URL(settings.prowlarr.url);
		const isProwlarrHost = target.hostname === configured.hostname || isLocalhost(target.hostname);
		if (isProwlarrHost && settings.prowlarr.apiKey && !target.searchParams.has("apikey")) {
			target.searchParams.set("apikey", settings.prowlarr.apiKey);
			return target.toString();
		}
	} catch {
		// Ignore URL parsing errors
	}
	return url;
}

/**
 * Rewrite URL to use configured Prowlarr host (for Docker scenarios)
 */
async function rewriteUrlForConfig(url: string): Promise<string> {
	try {
		const settings = await getSettings();
		const targetUrl = new URL(url);
		const configUrl = new URL(settings.prowlarr.url);

		// If target is localhost but config uses a different host, rewrite
		if (isLocalhost(targetUrl.hostname) && !isLocalhost(configUrl.hostname)) {
			targetUrl.protocol = configUrl.protocol;
			targetUrl.hostname = configUrl.hostname;
			if (configUrl.port) {
				targetUrl.port = configUrl.port;
			}
			return targetUrl.toString();
		}
	} catch {
		// Ignore URL parsing errors
	}
	return url;
}

/**
 * Resolves a result's magnet URI if it's an HTTP URL (likely a download link from Prowlarr).
 * Prowlarr typically redirects to a magnet: URL, so we capture the redirect location.
 * If it returns a .torrent file instead, we parse it to extract the magnet link.
 */
export async function resolveMagnetLink(url: string): Promise<string> {
	if (url.startsWith("magnet:")) {
		return url;
	}

	// Try with rewritten URL (for Docker scenarios)
	const authorizedUrl = await addApiKey(url);
	const primaryUrl = await rewriteUrlForConfig(authorizedUrl);
	const primaryResult = await tryFetchMagnet(primaryUrl);
	if (primaryResult) {
		return primaryResult;
	}

	// Fallback: try 'prowlarr' service name for docker-compose
	try {
		const targetUrl = new URL(authorizedUrl);
		if (isLocalhost(targetUrl.hostname)) {
			targetUrl.hostname = "prowlarr";
			const fallbackUrl = targetUrl.toString();

			if (fallbackUrl !== primaryUrl) {
				const fallbackResult = await tryFetchMagnet(fallbackUrl);
				if (fallbackResult) {
					return fallbackResult;
				}
			}
		}
	} catch {
		// Ignore URL parsing errors
	}

	// Return original URL if we couldn't resolve
	return url;
}

/**
 * Search Prowlarr for torrents
 */
export async function searchProwlarr(query: string, category?: string): Promise<IndexerResult[]> {
	const settings = await getSettings();
	const { url, apiKey } = settings.prowlarr;

	if (!apiKey) {
		console.error("Prowlarr API key not configured");
		return [];
	}

	const params = new URLSearchParams({
		apikey: apiKey,
		query,
		type: "search",
	});

	if (category) {
		params.append("categories", category);
	}

	try {
		// Prowlarr /api/v1/search
		const response = await fetch(`${url}/api/v1/search?${params}`, {
			headers: { Accept: "application/json" },
		});

		if (!response.ok) {
			console.error(`Prowlarr search failed: ${response.status} ${response.statusText}`);
			return [];
		}

		const data: ProwlarrResultItem[] = await response.json();
		return parseProwlarrResults(data);
	} catch (error) {
		console.error("Prowlarr search error:", error);
		return [];
	}
}

export interface FindBestTorrentOptions {
	mediaType?: "movie" | "episode";
	seasonNumber?: number;
	episodeNumber?: number;
	showTitle?: string;
	episodeTitle?: string | null;
	year?: number | null;
	/** Movie title, searched when no indexer answers the IMDb id */
	title?: string;
}

function getEpisodeSearchLabel(options?: FindBestTorrentOptions): string | null {
	if (!(options?.mediaType === "episode" && options.seasonNumber && options.episodeNumber)) {
		return null;
	}
	return `S${String(options.seasonNumber).padStart(2, "0")}E${String(options.episodeNumber).padStart(2, "0")}`;
}

function normalizeSearchText(value: string): string {
	return value
		.normalize("NFD")
		.replace(/\p{M}/gu, "") // "Déjà Vu" matches "Deja.Vu"
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function matchesShowTitle(title: string, showTitle?: string): boolean {
	if (!showTitle) {
		return true;
	}
	const normalizedShowTitle = normalizeSearchText(showTitle);
	if (!normalizedShowTitle) {
		return true;
	}
	return normalizeSearchText(title).includes(normalizedShowTitle);
}

function matchesEpisodeTitle(title: string, episodeTitle?: string | null): boolean {
	if (!episodeTitle) {
		return false;
	}
	const normalizedEpisodeTitle = normalizeSearchText(episodeTitle);
	if (!normalizedEpisodeTitle) {
		return false;
	}
	return normalizeSearchText(title).includes(normalizedEpisodeTitle);
}

function dedupeResults(results: IndexerResult[]): IndexerResult[] {
	const seenInfohashes = new Set<string>();
	const deduped: IndexerResult[] = [];
	for (const result of results) {
		if (seenInfohashes.has(result.infohash)) {
			continue;
		}
		seenInfohashes.add(result.infohash);
		deduped.push(result);
	}
	return deduped;
}

function buildEpisodeSearchQueries(imdbId: string, options: FindBestTorrentOptions): string[] {
	if (!(options.showTitle && options.seasonNumber && options.episodeNumber)) {
		return [imdbId, `imdb:${imdbId}`];
	}
	const paddedSeason = String(options.seasonNumber).padStart(2, "0");
	const paddedEpisode = String(options.episodeNumber).padStart(2, "0");
	const seasonEpisode = `S${paddedSeason}E${paddedEpisode}`;
	const fallbackQueries = [
		imdbId,
		`imdb:${imdbId}`,
		`${options.showTitle} ${seasonEpisode}`,
		`${options.showTitle} S${paddedSeason} E${paddedEpisode}`,
		`${options.showTitle} ${options.seasonNumber}x${paddedEpisode}`,
		`${options.showTitle} Season ${options.seasonNumber} Episode ${options.episodeNumber}`,
	];
	if (options.episodeTitle) {
		fallbackQueries.push(`${options.showTitle} ${seasonEpisode} ${options.episodeTitle}`);
		fallbackQueries.push(`${options.showTitle} ${options.episodeTitle}`);
	}
	if (options.year) {
		fallbackQueries.push(`${options.showTitle} ${options.year} ${seasonEpisode}`);
		fallbackQueries.push(`${options.showTitle} ${options.year} ${options.seasonNumber}x${paddedEpisode}`);
	}
	return Array.from(new Set(fallbackQueries));
}

function isExactEpisodeMatch(result: IndexerResult, options: FindBestTorrentOptions): boolean {
	if (!(options.seasonNumber && options.episodeNumber)) {
		return false;
	}
	if (!matchesEpisodeNumber(result.title, options.seasonNumber, options.episodeNumber)) {
		return false;
	}
	if (isSeasonPack(result.title)) {
		return false;
	}
	return matchesShowTitle(result.title, options.showTitle);
}

async function searchEpisodeTorrent(imdbId: string, options: FindBestTorrentOptions): Promise<IndexerResult[]> {
	const episodeLabel = getEpisodeSearchLabel(options) ?? imdbId;
	const queries = buildEpisodeSearchQueries(imdbId, options);
	const collectedResults: IndexerResult[] = [];
	for (const query of queries) {
		const queryResults = await searchProwlarr(query, TV_SEARCH_CATEGORY);
		console.log(`[Prowlarr] Query ${episodeLabel}: "${query}" -> ${queryResults.length} results`);
		collectedResults.push(...queryResults);
		if (queryResults.some((result) => isExactEpisodeMatch(result, options))) {
			break;
		}
	}
	return dedupeResults(collectedResults);
}

function logEpisodeSelectionSummary(
	episodeLabel: string,
	results: IndexerResult[],
	qualityFiltered: IndexerResult[],
	episodeFiltered: IndexerResult[],
	best: IndexerResult | null
): void {
	console.log(
		`[Prowlarr] ${episodeLabel} results raw=${results.length} quality=${qualityFiltered.length} filtered=${episodeFiltered.length}`
	);
	if (best) {
		console.log(`[Prowlarr] Selected ${episodeLabel}: ${best.title}`);
		return;
	}
	if (results.length === 0) {
		console.log(`[Prowlarr] No results returned for ${episodeLabel}`);
		return;
	}
	if (qualityFiltered.length === 0) {
		console.log(`[Prowlarr] All results rejected by quality filters for ${episodeLabel}`);
		return;
	}
	if (episodeFiltered.length === 0) {
		console.log(`[Prowlarr] All results rejected by episode filters for ${episodeLabel}`);
		console.log(
			`[Prowlarr] Candidate titles for ${episodeLabel}: ${results
				.slice(0, 5)
				.map((result) => result.title)
				.join(" | ")}`
		);
		return;
	}
	console.log(`[Prowlarr] No acceptable result selected for ${episodeLabel}`);
	console.log(
		`[Prowlarr] Candidate titles for ${episodeLabel}: ${episodeFiltered
			.slice(0, 5)
			.map((result) => result.title)
			.join(" | ")}`
	);
}

function filterCandidates(results: IndexerResult[], trustedGroups: string[], minSeeders: number): IndexerResult[] {
	const groupFiltered = filterByReleaseGroup(results, trustedGroups);
	const candidates = groupFiltered.length > 0 ? groupFiltered : results;
	const seederFiltered = candidates.filter((result) => result.seeders >= minSeeders);
	return seederFiltered.length > 0 ? seederFiltered : candidates;
}

/**
 * Most public indexers ignore IMDb ids, so when none answers, search "title year"
 * and keep only releases whose name contains the title.
 */
async function searchMovieTorrent(imdbId: string, options?: FindBestTorrentOptions): Promise<IndexerResult[]> {
	const results = await searchProwlarr(imdbId);
	if (results.length > 0 || !options?.title) {
		return results;
	}
	const title = normalizeSearchText(options.title);
	// indexers find nothing for "Déjà Vu", so search the plain-letter form
	const byTitle = await searchProwlarr([title, options.year].filter(Boolean).join(" "));
	return byTitle.filter((result) => normalizeSearchText(result.title).includes(title));
}

/**
 * Search and filter Prowlarr results for high-quality torrents.
 * Returns the best matching torrent or null.
 */
export async function findBestTorrent(imdbId: string, options?: FindBestTorrentOptions): Promise<IndexerResult | null> {
	const episodeLabel = getEpisodeSearchLabel(options);
	if (episodeLabel) {
		console.log(`[Prowlarr] Searching ${episodeLabel} with IMDb ${imdbId}`);
	}
	const settings = await getSettings();
	const results =
		options?.mediaType === "episode" && options.seasonNumber && options.episodeNumber
			? await searchEpisodeTorrent(imdbId, options)
			: await searchMovieTorrent(imdbId, options);
	const qualityFiltered = filterByQuality(results);
	const episodeFiltered =
		options?.mediaType === "episode" && options.seasonNumber && options.episodeNumber
			? filterForEpisodeResults(
					qualityFiltered,
					options.seasonNumber,
					options.episodeNumber,
					options.showTitle,
					options.episodeTitle
				)
			: qualityFiltered;
	const best = selectBestTorrent(
		filterCandidates(episodeFiltered, settings.prowlarr.trustedGroups, settings.prowlarr.minSeeders)
	);
	if (episodeLabel) {
		logEpisodeSelectionSummary(episodeLabel, results, qualityFiltered, episodeFiltered, best);
	}

	// Resolve HTTP download URLs to magnet links
	if (best?.magnetUri.startsWith("http")) {
		best.magnetUri = await resolveMagnetLink(best.magnetUri);
	}

	return best;
}

/** Cap on releases handed to the source picker. Keeps the response small and readable. */
const MAX_SOURCE_CANDIDATES = 40;

/**
 * Search indexers and return every acceptable release, best first.
 * findBestTorrent picks one release; this lets a person pick one instead.
 */
export async function searchSourceCandidates(query: string, isEpisode: boolean): Promise<IndexerResult[]> {
	const results = await searchProwlarr(query, isEpisode ? TV_SEARCH_CATEGORY : undefined);
	const candidates = dedupeResults(filterByQuality(results));
	candidates.sort((a, b) => calculateScore(b) - calculateScore(a));
	return candidates
		.slice(0, MAX_SOURCE_CANDIDATES)
		.map((candidate) => ({ ...candidate, magnetUri: stripApiKey(candidate.magnetUri) }));
}

// =============================================================================
// TV Season Search
// =============================================================================

/**
 * Patterns that indicate a single episode (to exclude from season pack results)
 */
const SINGLE_EPISODE_PATTERNS = [
	/\bE\d{1,3}\b/i, // E01, E12, etc.
	/\d{1,2}x\d{1,3}/i, // 1x01, 12x05, etc.
	/\bEpisode\s*\d+/i, // Episode 1, Episode 12, etc.
	/S\d{1,2}E\d{1,3}/i, // S01E01 (full pattern)
	/S\d{1,2}\s+E\d{1,3}/i, // S01 E01 (with space)
];

/**
 * Patterns that indicate a season pack
 */
const SEASON_PACK_PATTERNS = [
	/\bS\d{1,2}\b(?!E)/i, // S01, S02 (not followed by E)
	/\bSeason[\s.]*\d+\b/i, // Season 1, Season.1
	/\bComplete\b/i, // Complete
	/\bFull[\s.]*Season\b/i, // Full Season
];

/**
 * Minimum size for a season pack (in bytes) - approximately 1GB
 */
const MIN_SEASON_PACK_SIZE = 1 * 1024 * 1024 * 1024; // 1GB

/**
 * Check if a title matches a specific season number
 */
function matchesSeasonNumber(title: string, seasonNumber: number): boolean {
	const paddedSeason = seasonNumber.toString().padStart(2, "0");
	const patterns = [
		new RegExp(`\\bS${paddedSeason}\\b`, "i"), // S01, S02
		new RegExp(`\\bS${seasonNumber}\\b`, "i"), // S1, S2 (without padding)
		new RegExp(`\\bSeason[\\s.]*${seasonNumber}\\b`, "i"), // Season 1, Season.1
	];
	return patterns.some((pattern) => pattern.test(title));
}

/**
 * Check if a title is a single episode
 */
function isSingleEpisode(title: string): boolean {
	return SINGLE_EPISODE_PATTERNS.some((pattern) => pattern.test(title));
}

function matchesEpisodeNumber(title: string, seasonNumber: number, episodeNumber: number): boolean {
	const paddedSeason = seasonNumber.toString().padStart(2, "0");
	const paddedEpisode = episodeNumber.toString().padStart(2, "0");
	const patterns = [
		new RegExp(`\\bS${paddedSeason}E${paddedEpisode}\\b`, "i"),
		new RegExp(`\\bS${seasonNumber}E${episodeNumber}\\b`, "i"),
		new RegExp(`\\b${seasonNumber}x${episodeNumber}\\b`, "i"),
		new RegExp(`\\b${seasonNumber}x${paddedEpisode}\\b`, "i"),
	];
	return patterns.some((pattern) => pattern.test(title));
}

/**
 * Check if a title looks like a season pack
 */
function isSeasonPack(title: string): boolean {
	return SEASON_PACK_PATTERNS.some((pattern) => pattern.test(title));
}

function filterForEpisodeResults(
	results: IndexerResult[],
	seasonNumber: number,
	episodeNumber: number,
	showTitle?: string,
	episodeTitle?: string | null
): IndexerResult[] {
	const showFiltered = results.filter((result) => matchesShowTitle(result.title, showTitle));
	const candidates = showFiltered.length > 0 ? showFiltered : results;
	const exactMatches = candidates.filter((result) => matchesEpisodeNumber(result.title, seasonNumber, episodeNumber));
	if (exactMatches.length > 0) {
		const singleEpisodeMatches = exactMatches.filter((result) => !isSeasonPack(result.title));
		if (episodeTitle) {
			const titledMatches = singleEpisodeMatches.filter((result) =>
				matchesEpisodeTitle(result.title, episodeTitle)
			);
			if (titledMatches.length > 0) {
				return titledMatches;
			}
		}
		return singleEpisodeMatches;
	}
	const nonPackMatches = candidates.filter((result) => !isSeasonPack(result.title));
	return nonPackMatches;
}

/**
 * Filter results to only season packs for a specific season
 */
function filterForSeasonPacks(results: IndexerResult[], seasonNumber: number): IndexerResult[] {
	return results.filter((result) => {
		const title = result.title;

		// Must match the season number
		if (!matchesSeasonNumber(title, seasonNumber)) {
			return false;
		}

		// Exclude single episodes
		if (isSingleEpisode(title)) {
			return false;
		}

		// Prefer results that look like season packs or are large enough
		const looksLikeSeasonPack = isSeasonPack(title);
		const isLargeEnough = result.size >= MIN_SEASON_PACK_SIZE;

		return looksLikeSeasonPack || isLargeEnough;
	});
}

/**
 * Search Prowlarr for TV show season packs
 */
export async function searchSeasonTorrent(
	showTitle: string,
	seasonNumber: number,
	imdbId?: string
): Promise<IndexerResult[]> {
	const settings = await getSettings();
	const { apiKey } = settings.prowlarr;

	if (!apiKey) {
		console.error("Prowlarr API key not configured");
		return [];
	}

	// Format season number with padding
	const paddedSeason = seasonNumber.toString().padStart(2, "0");

	// Build search queries
	const searchQueries: string[] = [];

	if (imdbId) {
		searchQueries.push(`imdb:${imdbId} S${paddedSeason}`);
	}

	searchQueries.push(`${showTitle} S${paddedSeason}`);
	searchQueries.push(`${showTitle} Season ${seasonNumber}`);

	const allResults: IndexerResult[] = [];
	const seenInfohashes = new Set<string>();

	for (const query of searchQueries) {
		const results = await searchProwlarr(query);

		// Deduplicate
		for (const result of results) {
			if (!seenInfohashes.has(result.infohash)) {
				seenInfohashes.add(result.infohash);
				allResults.push(result);
			}
		}

		// If IMDB search worked, stop
		if (imdbId && allResults.length > 0) {
			break;
		}
	}

	return allResults;
}

/**
 * Find the best season pack torrent for a TV show season
 */
export async function findBestSeasonTorrent(
	showTitle: string,
	seasonNumber: number,
	imdbId?: string
): Promise<IndexerResult | null> {
	const settings = await getSettings();
	const results = await searchSeasonTorrent(showTitle, seasonNumber, imdbId);

	if (results.length === 0) {
		return null;
	}

	const qualityFiltered = filterByQuality(results);
	const seasonPacks = filterForSeasonPacks(qualityFiltered, seasonNumber);

	if (seasonPacks.length === 0) {
		// Fallback to non-episode files
		const nonEpisodes = qualityFiltered.filter(
			(r) => !isSingleEpisode(r.title) && matchesSeasonNumber(r.title, seasonNumber)
		);
		if (nonEpisodes.length > 0) {
			const seederFiltered = nonEpisodes.filter((r) => r.seeders >= settings.prowlarr.minSeeders);
			const best = selectBestTorrent(seederFiltered.length > 0 ? seederFiltered : nonEpisodes);

			if (best?.magnetUri.startsWith("http")) {
				best.magnetUri = await resolveMagnetLink(best.magnetUri);
			}
			return best;
		}
		return null;
	}

	const seederFiltered = seasonPacks.filter((r) => r.seeders >= settings.prowlarr.minSeeders);
	const best = selectBestTorrent(seederFiltered.length > 0 ? seederFiltered : seasonPacks);

	if (best?.magnetUri.startsWith("http")) {
		best.magnetUri = await resolveMagnetLink(best.magnetUri);
	}
	return best;
}

// =============================================================================
// Indexer Management
// =============================================================================

export interface ProwlarrIndexer {
	id: number;
	name: string;
	fields: Array<{
		name: string;
		value?: string | number | boolean | null;
	}>;
	implementationName: string;
	implementation: string;
	configContract: string;
	infoLink: string;
	tags: number[];
	enable: boolean;
	protocol: string;
	priority: number;
}

export interface ProwlarrIndexerSchema {
	id: number;
	name: string;
	implementation: string;
	implementationName: string;
	configContract: string;
	infoLink: string;
	fields: Array<{
		order: number;
		name: string;
		label: string;
		value?: string | number | boolean | null;
		type: string;
		advanced: boolean;
		helpText?: string;
		selectOptions?: Array<{
			value: number | string;
			name: string;
		}>;
	}>;
	tags: number[];
}

interface ProwlarrTag {
	id: number;
	label: string;
}

const FLARESOLVERR_TAG_LABEL = "flaresolverr";

function requiresFlaresolverr(indexer: Partial<ProwlarrIndexer>): boolean {
	return indexer.fields?.some((field) => field.name === "info_flaresolverr") ?? false;
}

async function getOrCreateFlaresolverrTag(url: string, apiKey: string): Promise<number | null> {
	const response = await fetch(`${url}/api/v1/tag`, {
		headers: { "X-Api-Key": apiKey },
	});

	if (!response.ok) {
		return null;
	}

	const tags = (await response.json()) as ProwlarrTag[];
	const existingTag = tags.find((tag) => tag.label === FLARESOLVERR_TAG_LABEL);
	if (existingTag) {
		return existingTag.id;
	}

	const createResponse = await fetch(`${url}/api/v1/tag`, {
		method: "POST",
		headers: {
			"X-Api-Key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ label: FLARESOLVERR_TAG_LABEL }),
	});

	if (!createResponse.ok) {
		return null;
	}

	const createdTag = (await createResponse.json()) as ProwlarrTag;
	return createdTag.id;
}

/**
 * Get all configured indexers
 */
export async function getProwlarrIndexers(): Promise<ProwlarrIndexer[]> {
	const settings = await getSettings();
	const { url, apiKey } = settings.prowlarr;

	if (!apiKey) {
		return [];
	}

	try {
		const response = await fetch(`${url}/api/v1/indexer`, {
			headers: { "X-Api-Key": apiKey },
		});
		if (!response.ok) {
			return [];
		}
		return await response.json();
	} catch (error) {
		console.error("Failed to get indexers:", error);
		return [];
	}
}

/**
 * Get available indexer schemas (indexers that can be added)
 */
export async function getProwlarrIndexerSchemas(): Promise<ProwlarrIndexerSchema[]> {
	const settings = await getSettings();
	const { url, apiKey } = settings.prowlarr;

	if (!apiKey) {
		return [];
	}

	try {
		const response = await fetch(`${url}/api/v1/indexer/schema`, {
			headers: { "X-Api-Key": apiKey },
		});
		if (!response.ok) {
			return [];
		}
		return await response.json();
	} catch (error) {
		console.error("Failed to get indexer schemas:", error);
		return [];
	}
}

/**
 * Add a new indexer
 */
export async function addProwlarrIndexer(indexer: Partial<ProwlarrIndexer>): Promise<boolean> {
	const settings = await getSettings();
	const { url, apiKey } = settings.prowlarr;

	if (!apiKey) {
		return false;
	}

	try {
		// Ensure basic fields are present
		const payload = {
			...indexer,
			id: 0, // Force ID to 0 for creation
			enable: true,
			priority: 25,
			appProfileId: 1, // Default profile
		};

		if (requiresFlaresolverr(payload)) {
			const tagId = await getOrCreateFlaresolverrTag(url, apiKey);
			if (tagId !== null) {
				payload.tags = [...new Set([...(payload.tags ?? []), tagId])];
			}
		}

		console.log("Adding Prowlarr indexer with payload:", JSON.stringify(payload));

		const response = await fetch(`${url}/api/v1/indexer`, {
			method: "POST",
			headers: {
				"X-Api-Key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			const text = await response.text();
			console.error("Failed to add indexer, Prowlarr response:", response.status, text);
			return false;
		}

		return response.ok;
	} catch (error) {
		console.error("Failed to add indexer:", error);
		return false;
	}
}

/**
 * Delete an indexer
 */
export async function deleteProwlarrIndexer(id: number): Promise<boolean> {
	const settings = await getSettings();
	const { url, apiKey } = settings.prowlarr;

	if (!apiKey) {
		return false;
	}

	try {
		const response = await fetch(`${url}/api/v1/indexer/${id}`, {
			method: "DELETE",
			headers: { "X-Api-Key": apiKey },
		});

		return response.ok;
	} catch (error) {
		console.error("Failed to delete indexer:", error);
		return false;
	}
}

/**
 * Test indexer connectivity
 */
export async function testProwlarrConnection(
	prowlarrUrl?: string,
	prowlarrApiKey?: string
): Promise<{ success: boolean; message?: string }> {
	const settings = await getSettings();
	const url = prowlarrUrl || settings.prowlarr.url;
	const apiKey = prowlarrApiKey || settings.prowlarr.apiKey;

	if (!(url && apiKey)) {
		return { success: false, message: "URL or API Key missing" };
	}

	try {
		// Use /ping endpoint which is public, but we want to test auth too
		// So we use /api/v1/health which requires auth
		const response = await fetch(`${url}/api/v1/health`, {
			headers: { "X-Api-Key": apiKey },
		});

		if (response.ok) {
			return { success: true };
		}
		return { success: false, message: `Status: ${response.status}` };
	} catch (error) {
		return { success: false, message: error instanceof Error ? error.message : "Connection failed" };
	}
}
