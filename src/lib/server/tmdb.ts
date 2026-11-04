import { type CatalogSearchRequest, getCatalogGenreIds } from "$lib/data/search";
import { type AppSettings, getSettings } from "$lib/server/settings";

interface TMDBGenre {
	id: number;
	name: string;
}

interface TMDBMovie {
	id: number;
	title: string;
	release_date: string;
	poster_path: string | null;
	backdrop_path: string | null;
	overview: string;
	vote_average?: number;
	runtime?: number;
	genres?: TMDBGenre[];
	original_language?: string;
	adult?: boolean;
}

interface TMDBSeason {
	episode_count: number;
	name: string;
	season_number: number;
}

interface TMDBTVShow {
	id: number;
	name: string;
	first_air_date: string;
	poster_path: string | null;
	backdrop_path: string | null;
	overview: string;
	vote_average?: number;
	number_of_seasons?: number;
	episode_run_time?: number[];
	genres?: TMDBGenre[];
	original_language?: string;
	adult?: boolean;
	seasons?: TMDBSeason[];
}

interface TMDBSearchResult {
	results: TMDBMovie[];
}

interface TMDBTVSearchResult {
	results: TMDBTVShow[];
}

interface TMDBEpisode {
	id?: number;
	episode_number: number;
	name: string;
	overview: string;
	still_path: string | null;
	runtime: number | null;
	air_date: string;
}

interface TMDBSeasonDetail {
	season_number: number;
	name: string;
	episodes: TMDBEpisode[];
}

export interface TMDBMetadata {
	tmdbId: number | null;
	title: string;
	year: number | null;
	posterUrl: string | null;
	backdropUrl: string | null;
	overview: string | null;
	runtime?: number | null;
	genres?: string | null;
	originalLanguage?: string | null;
	certification?: string | null;
	voteAverage?: number | null;
	totalSeasons?: number | null;
}

export class AdultContentError extends Error {
	constructor() {
		super("Adult content is not available");
		this.name = "AdultContentError";
	}
}

export interface SeasonMetadata {
	seasonNumber: number;
	name: string | null;
	episodes: EpisodeMetadata[];
}

interface TMDBEpisodeExternalIds {
	imdb_id: string | null;
}

interface EpisodeMetadata {
	tmdbId: number | null;
	imdbId: string | null;
	episodeNumber: number;
	title: string | null;
	overview: string | null;
	stillPath: string | null;
	runtime: number | null;
	airDate: string | null;
}

// Simplified season data for context menu
export interface SeasonSummary {
	seasonNumber: number;
	name: string;
	episodeCount: number;
}

// =============================================================================
// Browse Item Type (for discovery)
// =============================================================================

export interface BrowseItem {
	tmdbId: number;
	imdbId: string | null;
	title: string;
	year: number | null;
	posterUrl: string | null;
	backdropUrl: string | null;
	overview: string | null;
	voteAverage: number | null;
	genres: string[];
	mediaType: "movie" | "show";
	certification: string | null;
	// Set by the cache lookup
	magnetLink?: string;
	needsResolve: boolean;
}
export interface TmdbCatalogSearchResult {
	items: BrowseItem[];
	page: number;
	totalPages: number;
}

// =============================================================================
// Trending Movies and Shows
// =============================================================================

interface TMDBTrendingItem {
	id: number;
	title?: string;
	name?: string;
	release_date?: string;
	first_air_date?: string;
	poster_path: string | null;
	backdrop_path: string | null;
	overview: string;
	vote_average: number;
	genre_ids?: number[];
	popularity?: number;
	adult?: boolean;
	media_type?: "movie" | "tv" | "show" | "person";
}

interface TMDBTrendingResponse {
	results: TMDBTrendingItem[];
	page: number;
	total_pages: number;
}

// Genre ID to name mapping for movies
const MOVIE_GENRES: Record<number, string> = {
	28: "Action",
	12: "Adventure",
	16: "Animation",
	35: "Comedy",
	80: "Crime",
	99: "Documentary",
	18: "Drama",
	10751: "Family",
	14: "Fantasy",
	36: "History",
	27: "Horror",
	10402: "Music",
	9648: "Mystery",
	10749: "Romance",
	878: "Science Fiction",
	10770: "TV Movie",
	53: "Thriller",
	10752: "War",
	37: "Western",
};

const TV_GENRES: Record<number, string> = {
	10759: "Action & Adventure",
	16: "Animation",
	35: "Comedy",
	80: "Crime",
	99: "Documentary",
	18: "Drama",
	10751: "Family",
	10762: "Kids",
	9648: "Mystery",
	10763: "News",
	10764: "Reality",
	10765: "Sci-Fi & Fantasy",
	10766: "Soap",
	10767: "Talk",
	10768: "War & Politics",
	37: "Western",
};

function mapTmdbToBrowseItem(item: TMDBTrendingItem, defaultType: "movie" | "show", settings: AppSettings): BrowseItem {
	let type = defaultType;
	if (item.media_type === "movie") {
		type = "movie";
	} else if (item.media_type === "tv" || item.media_type === "show") {
		type = "show";
	}
	const title = item.title || item.name || "Unknown Title";
	const date = item.release_date || item.first_air_date;
	const year = date ? Number.parseInt(date.slice(0, 4), 10) : null;
	const genres = (item.genre_ids ?? [])
		.map((id) => (type === "movie" ? MOVIE_GENRES[id] : TV_GENRES[id]))
		.filter(Boolean);

	return {
		tmdbId: item.id,
		imdbId: null, // Will be fetched separately
		title,
		year,
		posterUrl: item.poster_path ? `${settings.tmdb.imageBaseUrl}/w342${item.poster_path}` : null,
		backdropUrl: item.backdrop_path ? `${settings.tmdb.imageBaseUrl}/w780${item.backdrop_path}` : null,
		overview: item.overview ?? null,
		voteAverage: item.vote_average ?? null,
		genres,
		mediaType: type === "movie" ? type : "show",
		certification: null, // Will be fetched separately
		needsResolve: true,
	};
}

/**
 * Get trending content from TMDB
 */
export async function getTrending(
	timeWindow: "day" | "week" = "day",
	page = 1,
	type: "all" | "movie" | "show" = "all"
): Promise<{ items: BrowseItem[]; totalPages: number }> {
	const settings = await getSettings();
	const tmdbType = type === "show" ? "tv" : type;
	const res = await fetch(
		`${settings.tmdb.baseUrl}/trending/${tmdbType}/${timeWindow}?api_key=${settings.tmdb.apiKey}&page=${page}&language=${settings.tmdb.language}&include_adult=false`
	);

	if (!res.ok) {
		console.error(`[TMDB] Trending ${type} failed: ${res.status}`);
		return { items: [], totalPages: 0 };
	}

	const data: TMDBTrendingResponse = await res.json();
	const items = data.results
		.filter(
			(item) =>
				item.adult !== true &&
				(type !== "all" ||
					item.media_type === "movie" ||
					item.media_type === "tv" ||
					item.media_type === "show")
		)
		.map((item) => mapTmdbToBrowseItem(item, type === "all" ? "movie" : type, settings));

	return { items, totalPages: data.total_pages };
}

const recommendationsCache = new Map<string, { items: BrowseItem[]; expiresAt: number }>();
const RECOMMENDATIONS_TTL = 6 * 60 * 60 * 1000; // 6 hours
const RECOMMENDATIONS_MAX_SIZE = 500;

/**
 * Get TMDB's "people who liked this also liked" titles for one movie or show,
 * or with no id, the films in cinemas now
 */
export async function getRecommendations(tmdbId: number | null, type: "movie" | "show"): Promise<BrowseItem[]> {
	const cacheKey = tmdbId === null ? "now_playing" : `${type}:${tmdbId}`;
	const now = Date.now();
	const cached = recommendationsCache.get(cacheKey);
	if (cached && now < cached.expiresAt) {
		return cached.items;
	}

	const settings = await getSettings();
	const tmdbType = type === "show" ? "tv" : "movie";
	const endpoint = tmdbId === null ? "movie/now_playing" : `${tmdbType}/${tmdbId}/recommendations`;
	const res = await fetch(
		`${settings.tmdb.baseUrl}/${endpoint}?api_key=${settings.tmdb.apiKey}&language=${settings.tmdb.language}`
	);
	if (!res.ok) {
		console.error(`[TMDB] Recommendations ${cacheKey} failed: ${res.status}`);
		return [];
	}

	const data: TMDBTrendingResponse = await res.json();
	const items = data.results
		.filter((item) => item.adult !== true && item.media_type !== "person")
		.map((item) => mapTmdbToBrowseItem(item, type, settings));

	if (recommendationsCache.size >= RECOMMENDATIONS_MAX_SIZE) {
		const firstKey = recommendationsCache.keys().next().value;
		if (firstKey) {
			recommendationsCache.delete(firstKey);
		}
	}
	recommendationsCache.set(cacheKey, { items, expiresAt: now + RECOMMENDATIONS_TTL });
	return items;
}

/**
 * In-memory cache for browse item details (IMDB ID + certification).
 * These rarely change, so a 3-hour TTL avoids hammering TMDB with
 * ~20 requests per browse page load.
 */
const browseDetailsCache = new Map<
	string,
	{ imdbId: string | null; certification: string | null; expiresAt: number }
>();
const BROWSE_DETAILS_TTL = 3 * 60 * 60 * 1000; // 3 hours
const BROWSE_DETAILS_MAX_SIZE = 500; // Evict oldest when cache exceeds this

/**
 * Get cached item details (IMDB ID + Certification)
 */
export async function getBrowseItemDetails(
	tmdbId: number,
	type: "movie" | "show"
): Promise<{ imdbId: string | null; certification: string | null }> {
	const cacheKey = `${type}:${tmdbId}`;
	const now = Date.now();

	// Check in-memory cache first
	const cached = browseDetailsCache.get(cacheKey);
	if (cached && now < cached.expiresAt) {
		return { imdbId: cached.imdbId, certification: cached.certification };
	}

	const settings = await getSettings();
	// For movies: append_to_response=external_ids,release_dates
	// For tv: append_to_response=external_ids,content_ratings
	const append = type === "movie" ? "external_ids,release_dates" : "external_ids,content_ratings";

	const res = await fetch(
		`${settings.tmdb.baseUrl}/${type}/${tmdbId}?api_key=${settings.tmdb.apiKey}&append_to_response=${append}&language=${settings.tmdb.language}`
	);

	if (!res.ok) {
		return { imdbId: null, certification: null };
	}

	const data = await res.json();
	if (data.adult === true) {
		throw new AdultContentError();
	}
	const imdbId = data.external_ids?.imdb_id ?? null;
	let certification: string | null = null;

	if (type === "movie" && data.release_dates?.results) {
		const usRelease = data.release_dates.results.find((r: { iso_3166_1: string }) => r.iso_3166_1 === "US");
		if (usRelease) {
			const theatrical = usRelease.release_dates.find(
				(r: { type: number; certification: string }) => r.type === 3 && r.certification
			);
			const anyCert = usRelease.release_dates.find((r: { certification: string }) => r.certification);
			certification = theatrical?.certification || anyCert?.certification || null;
		}
	} else if (type === "show" && data.content_ratings?.results) {
		const usRating = data.content_ratings.results.find((r: { iso_3166_1: string }) => r.iso_3166_1 === "US");
		certification = usRating?.rating || null;
	}

	// Store in cache (evict oldest entries if over limit)
	if (browseDetailsCache.size >= BROWSE_DETAILS_MAX_SIZE) {
		const firstKey = browseDetailsCache.keys().next().value;
		if (firstKey) {
			browseDetailsCache.delete(firstKey);
		}
	}
	browseDetailsCache.set(cacheKey, { imdbId, certification, expiresAt: now + BROWSE_DETAILS_TTL });

	return { imdbId, certification };
}

// =============================================================================
// Movie Search & Details
// =============================================================================

async function tmdbSearch<T extends { results: unknown[] }>(
	endpoint: string,
	extraParams: Record<string, string> = {}
): Promise<T["results"]> {
	const settings = await getSettings();
	const params = new URLSearchParams({
		api_key: settings.tmdb.apiKey,
		language: settings.tmdb.language,
		...extraParams,
		include_adult: "false",
	});
	const res = await fetch(`${settings.tmdb.baseUrl}${endpoint}?${params}`);
	if (!res.ok) {
		console.error(`[TMDB] Search ${endpoint} failed: ${res.status} ${res.statusText}`);
		return [];
	}
	const data: T = await res.json();
	if (!(data.results && Array.isArray(data.results))) {
		console.error("[TMDB] Invalid response - no results array:", data);
		return [];
	}
	return data.results;
}

export async function searchMovie(query: string, year?: number | null): Promise<TMDBMetadata[]> {
	const settings = await getSettings();
	const extra: Record<string, string> = { query };
	if (year) {
		extra.year = String(year);
	}

	const results = await tmdbSearch<TMDBSearchResult>("/search/movie", extra);

	return (results as TMDBMovie[])
		.filter((movie) => movie.adult !== true)
		.map((movie) => ({
			tmdbId: movie.id,
			title: movie.title,
			year: movie.release_date ? Number.parseInt(movie.release_date.slice(0, 4), 10) : null,
			posterUrl: movie.poster_path ? `${settings.tmdb.imageBaseUrl}/w342${movie.poster_path}` : null,
			backdropUrl: movie.backdrop_path ? `${settings.tmdb.imageBaseUrl}/w780${movie.backdrop_path}` : null,
			overview: movie.overview ?? null,
			voteAverage: movie.vote_average ?? null,
		}));
}

export async function getMovieDetails(tmdbId: number): Promise<TMDBMetadata> {
	const settings = await getSettings();
	const res = await fetch(
		`${settings.tmdb.baseUrl}/movie/${tmdbId}?api_key=${settings.tmdb.apiKey}&append_to_response=release_dates&language=${settings.tmdb.language}`
	);

	if (!res.ok) {
		console.error(`[TMDB] Failed to fetch movie details for ${tmdbId}: ${res.status}`);
		throw new Error(`TMDB API error: ${res.status}`);
	}

	const movie: TMDBMovie & {
		release_dates?: {
			results: Array<{ iso_3166_1: string; release_dates: Array<{ certification: string; type: number }> }>;
		};
	} = await res.json();

	if (!movie?.id) {
		console.error(`[TMDB] Invalid movie response for ${tmdbId}:`, movie);
		throw new Error("Invalid TMDB response");
	}
	if (movie.adult === true) {
		throw new AdultContentError();
	}

	let certification: string | null = null;
	const usRelease = movie.release_dates?.results?.find((r) => r.iso_3166_1 === "US");
	if (usRelease) {
		const theatrical = usRelease.release_dates.find((r) => r.type === 3 && r.certification);
		const anyCert = usRelease.release_dates.find((r) => r.certification);
		certification = theatrical?.certification || anyCert?.certification || null;
	}

	return {
		tmdbId: movie.id,
		title: movie.title,
		year: movie.release_date ? Number.parseInt(movie.release_date.slice(0, 4), 10) : null,
		posterUrl: movie.poster_path ? `${settings.tmdb.imageBaseUrl}/w342${movie.poster_path}` : null,
		backdropUrl: movie.backdrop_path ? `${settings.tmdb.imageBaseUrl}/w780${movie.backdrop_path}` : null,
		overview: movie.overview ?? null,
		voteAverage: movie.vote_average ?? null,
		runtime: movie.runtime ?? null,
		genres: movie.genres ? JSON.stringify(movie.genres.map((g) => g.name)) : null,
		originalLanguage: movie.original_language ?? null,
		certification,
	};
}

// =============================================================================
// TV Show Search & Details
// =============================================================================

export async function searchTVShow(query: string, year?: number | null): Promise<TMDBMetadata[]> {
	const settings = await getSettings();
	const extra: Record<string, string> = { query };
	if (year) {
		extra.first_air_date_year = String(year);
	}

	const results = await tmdbSearch<TMDBTVSearchResult>("/search/tv", extra);

	return (results as TMDBTVShow[])
		.filter((show) => show.adult !== true)
		.map((show) => ({
			tmdbId: show.id,
			title: show.name,
			year: show.first_air_date ? Number.parseInt(show.first_air_date.slice(0, 4), 10) : null,
			posterUrl: show.poster_path ? `${settings.tmdb.imageBaseUrl}/w342${show.poster_path}` : null,
			backdropUrl: show.backdrop_path ? `${settings.tmdb.imageBaseUrl}/w780${show.backdrop_path}` : null,
			overview: show.overview ?? null,
			voteAverage: show.vote_average ?? null,
			totalSeasons: show.number_of_seasons ?? null,
		}));
}
interface CatalogCandidate {
	item: BrowseItem;
	popularity: number;
}

async function fetchTmdbCatalogPage(
	settings: AppSettings,
	endpoint: string,
	extraParams: Record<string, string>
): Promise<TMDBTrendingResponse> {
	const params = new URLSearchParams({
		api_key: settings.tmdb.apiKey,
		language: settings.tmdb.language,
		...extraParams,
		include_adult: "false",
	});
	const response = await fetch(`${settings.tmdb.baseUrl}${endpoint}?${params}`);
	if (!response.ok) {
		console.error(`[TMDB] Catalog ${endpoint} failed: ${response.status} ${response.statusText}`);
		return { results: [], page: 1, total_pages: 0 };
	}
	const data: TMDBTrendingResponse = await response.json();
	if (!Array.isArray(data.results)) {
		console.error(`[TMDB] Catalog ${endpoint} returned an invalid result`);
		return { results: [], page: 1, total_pages: 0 };
	}
	return data;
}

interface CatalogBranch {
	candidates: CatalogCandidate[];
	totalPages: number;
}

function getCatalogRequestDetails(
	request: CatalogSearchRequest,
	mediaType: "movie" | "show",
	genreIds: number[]
): { endpoint: string; params: Record<string, string> } {
	const tmdbType = mediaType === "show" ? "tv" : "movie";
	const params: Record<string, string> = { page: String(request.page) };
	if (request.query) {
		params.query = request.query;
		return { endpoint: `/search/${tmdbType}`, params };
	}

	const dateField = mediaType === "movie" ? "primary_release_date" : "first_air_date";
	if (request.filters.yearFrom !== null) {
		params[`${dateField}.gte`] = `${request.filters.yearFrom}-01-01`;
	}
	if (request.filters.yearTo !== null) {
		params[`${dateField}.lte`] = `${request.filters.yearTo}-12-31`;
	}
	if (request.filters.rating > 0) {
		params["vote_average.gte"] = String(request.filters.rating);
	}
	if (genreIds.length > 0) {
		params.with_genres = genreIds.join("|");
	}
	switch (request.filters.sort) {
		case "rating":
			params.sort_by = "vote_average.desc";
			params["vote_count.gte"] = "25";
			break;
		case "newest":
			params.sort_by = `${dateField}.desc`;
			break;
		case "oldest":
			params.sort_by = `${dateField}.asc`;
			break;
		default:
			params.sort_by = "popularity.desc";
	}
	return { endpoint: `/discover/${tmdbType}`, params };
}

function matchesCatalogFilters(item: TMDBTrendingItem, request: CatalogSearchRequest, genreIds: number[]): boolean {
	if (item.adult === true || (request.filters.rating > 0 && item.vote_average < request.filters.rating)) {
		return false;
	}
	const date = item.release_date || item.first_air_date;
	const year = date ? Number.parseInt(date.slice(0, 4), 10) : null;
	if (request.filters.yearFrom !== null && (year === null || year < request.filters.yearFrom)) {
		return false;
	}
	if (request.filters.yearTo !== null && (year === null || year > request.filters.yearTo)) {
		return false;
	}
	return genreIds.length === 0 || (item.genre_ids ?? []).some((id) => genreIds.includes(id));
}

async function searchCatalogBranch(
	settings: AppSettings,
	request: CatalogSearchRequest,
	mediaType: "movie" | "show"
): Promise<CatalogBranch> {
	const genreIds = getCatalogGenreIds(request.filters.genres, mediaType);
	if (genreIds === null) {
		return { candidates: [], totalPages: 0 };
	}
	const { endpoint, params } = getCatalogRequestDetails(request, mediaType, genreIds);
	const data = await fetchTmdbCatalogPage(settings, endpoint, params);
	const candidates = data.results
		.filter((item) => matchesCatalogFilters(item, request, genreIds))
		.map((item) => ({
			item: mapTmdbToBrowseItem(item, mediaType, settings),
			popularity: item.popularity ?? 0,
		}));
	return {
		candidates,
		totalPages: Math.min(500, data.total_pages),
	};
}

function sortCatalogCandidates(candidates: CatalogCandidate[], request: CatalogSearchRequest): void {
	switch (request.filters.sort) {
		case "rating":
			candidates.sort((a, b) => (b.item.voteAverage ?? -1) - (a.item.voteAverage ?? -1));
			return;
		case "newest":
			candidates.sort((a, b) => (b.item.year ?? -1) - (a.item.year ?? -1));
			return;
		case "oldest":
			candidates.sort(
				(a, b) => (a.item.year ?? Number.MAX_SAFE_INTEGER) - (b.item.year ?? Number.MAX_SAFE_INTEGER)
			);
			return;
		case "popular":
			candidates.sort((a, b) => b.popularity - a.popularity);
			return;
		default:
			if (!request.query) {
				candidates.sort((a, b) => b.popularity - a.popularity);
				return;
			}
	}
	const normalizedQuery = request.query.toLowerCase();
	candidates.sort((a, b) => {
		const aTitle = a.item.title.toLowerCase();
		const bTitle = b.item.title.toLowerCase();
		const aScore = aTitle === normalizedQuery ? 2 : Number(aTitle.startsWith(normalizedQuery));
		const bScore = bTitle === normalizedQuery ? 2 : Number(bTitle.startsWith(normalizedQuery));
		return bScore - aScore || b.popularity - a.popularity;
	});
}

export async function searchTmdbCatalog(request: CatalogSearchRequest): Promise<TmdbCatalogSearchResult> {
	const { filters, page, query } = request;
	if (query.length === 1) {
		return { items: [], page: 1, totalPages: 0 };
	}

	const settings = await getSettings();
	const mediaTypes: Array<"movie" | "show"> = filters.media === "all" ? ["movie", "show"] : [filters.media];
	const branches = await Promise.all(
		mediaTypes.map((mediaType) => searchCatalogBranch(settings, request, mediaType))
	);
	const seen = new Set<string>();
	const candidates = branches
		.flatMap((branch) => branch.candidates)
		.filter(({ item }) => {
			const key = `${item.mediaType}:${item.tmdbId}`;
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
	sortCatalogCandidates(candidates, request);

	return {
		items: candidates.map(({ item }) => item),
		page,
		totalPages: branches.reduce((maximum, branch) => Math.max(maximum, branch.totalPages), 0),
	};
}

export async function getTVDetails(tmdbId: number): Promise<TMDBMetadata & { totalSeasons: number }> {
	const settings = await getSettings();
	const res = await fetch(
		`${settings.tmdb.baseUrl}/tv/${tmdbId}?api_key=${settings.tmdb.apiKey}&append_to_response=content_ratings&language=${settings.tmdb.language}`
	);

	if (!res.ok) {
		console.error(`[TMDB] Failed to fetch TV details for ${tmdbId}: ${res.status}`);
		throw new Error(`TMDB API error: ${res.status}`);
	}

	const show: TMDBTVShow & { content_ratings?: { results: Array<{ iso_3166_1: string; rating: string }> } } =
		await res.json();

	if (!show?.id) {
		console.error(`[TMDB] Invalid TV response for ${tmdbId}:`, show);
		throw new Error("Invalid TMDB response");
	}
	if (show.adult === true) {
		throw new AdultContentError();
	}

	const usRating = show.content_ratings?.results?.find((r) => r.iso_3166_1 === "US");
	const certification = usRating?.rating || null;

	return {
		tmdbId: show.id,
		title: show.name,
		year: show.first_air_date ? Number.parseInt(show.first_air_date.slice(0, 4), 10) : null,
		posterUrl: show.poster_path ? `${settings.tmdb.imageBaseUrl}/w342${show.poster_path}` : null,
		backdropUrl: show.backdrop_path ? `${settings.tmdb.imageBaseUrl}/w780${show.backdrop_path}` : null,
		overview: show.overview ?? null,
		voteAverage: show.vote_average ?? null,
		totalSeasons: show.number_of_seasons ?? 0,
		runtime: show.episode_run_time?.[0] ?? null,
		genres: show.genres ? JSON.stringify(show.genres.map((g) => g.name)) : null,
		originalLanguage: show.original_language ?? null,
		certification,
	};
}

/**
 * Get all seasons summary for a TV show (for context menu)
 * Excludes specials (season 0) by default
 */
export async function getTVSeasons(tmdbId: number, includeSpecials = false): Promise<SeasonSummary[]> {
	const settings = await getSettings();
	const res = await fetch(
		`${settings.tmdb.baseUrl}/tv/${tmdbId}?api_key=${settings.tmdb.apiKey}&language=${settings.tmdb.language}`
	);

	if (!res.ok) {
		console.error(`[TMDB] Failed to fetch TV seasons for ${tmdbId}: ${res.status}`);
		throw new Error(`TMDB API error: ${res.status}`);
	}

	const show: TMDBTVShow = await res.json();

	if (!show?.seasons) {
		return [];
	}
	if (show.adult === true) {
		return [];
	}

	return show.seasons
		.filter((season) => includeSpecials || season.season_number > 0)
		.map((season) => ({
			seasonNumber: season.season_number,
			name: season.name || `Season ${season.season_number}`,
			episodeCount: season.episode_count,
		}));
}

export async function getSeasonDetails(tmdbId: number, seasonNumber: number): Promise<SeasonMetadata> {
	const settings = await getSettings();
	const res = await fetch(
		`${settings.tmdb.baseUrl}/tv/${tmdbId}/season/${seasonNumber}?api_key=${settings.tmdb.apiKey}&language=${settings.tmdb.language}`
	);

	if (!res.ok) {
		console.error(`[TMDB] Failed to fetch season ${seasonNumber} for TV ${tmdbId}: ${res.status}`);
		throw new Error(`TMDB API error: ${res.status}`);
	}

	const season: TMDBSeasonDetail = await res.json();

	return {
		seasonNumber: season.season_number,
		name: season.name ?? null,
		episodes:
			season.episodes?.map((ep) => ({
				tmdbId: ep.id ?? null,
				imdbId: null,
				episodeNumber: ep.episode_number,
				title: ep.name ?? null,
				overview: ep.overview ?? null,
				stillPath: ep.still_path ? `${settings.tmdb.imageBaseUrl}/w300${ep.still_path}` : null,
				runtime: ep.runtime ?? null,
				airDate: ep.air_date ?? null,
			})) ?? [],
	};
}

async function getEpisodeImdbId(tmdbId: number, seasonNumber: number, episodeNumber: number): Promise<string | null> {
	const settings = await getSettings();
	const res = await fetch(
		`${settings.tmdb.baseUrl}/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}/external_ids?api_key=${settings.tmdb.apiKey}`
	);

	if (!res.ok) {
		console.error(
			`[TMDB] Failed to fetch external ids for TV ${tmdbId} season ${seasonNumber} episode ${episodeNumber}: ${res.status}`
		);
		return null;
	}

	const data: TMDBEpisodeExternalIds = await res.json();
	return data.imdb_id ?? null;
}

export async function getSeasonDetailsWithExternalIds(tmdbId: number, seasonNumber: number): Promise<SeasonMetadata> {
	const season = await getSeasonDetails(tmdbId, seasonNumber);
	const episodes = await Promise.all(
		season.episodes.map(async (episode) => ({
			...episode,
			imdbId: await getEpisodeImdbId(tmdbId, seasonNumber, episode.episodeNumber),
		}))
	);

	return {
		...season,
		episodes,
	};
}

// =============================================================================
// TV Show Detection
// =============================================================================

// Common patterns that indicate a TV show in filenames
const TV_PATTERNS = [
	// Standard S01E01 format (most common)
	/S\d{1,2}E\d{1,3}/i,
	/S\d{1,2}\s?E\d{1,3}/i,

	// 1x01 format
	/\d{1,2}x\d{1,3}/i,

	// Anime / Absolute Numbering (e.g. " - 05", " - 124", " - 01v2")
	// Watch out for years (2024), so we check for surrounding spaces or brackets
	/\s-\s\d{2,4}(?:v\d)?(?:\s|\[|\.\w{3}|$)/,
	/\[\d{2,4}\]/, // [01] or [124] often used in anime

	// Date based (e.g. 2024.01.24, 2024-01-24) - common for daily shows
	/\d{4}[.-]\d{2}[.-]\d{2}/,

	// "Season X" or "Series X"
	/(?:Season|Series)[\s.]*\d+/i,

	// "Episode X"
	/Episode[\s.]*\d+/i,

	// Standalone "E01" if clearer context (often risky, but keeping for coverage)
	/\bE\d{1,3}\b/i,

	// Mini-series / Multi-part
	/Part[\s.]*\d+/i,

	// Keyword "Complete" often implies a season pack
	/Complete\s*(?:Season|Series)/i,

	// Range formats (S01-S03)
	/S\d{1,2}-S\d{1,2}/i,

	// Standalone "S01" (Season packs)
	/\bS\d{1,2}\b/i,

	// Year ranges (2019-2022) often imply a show run
	/\(\d{4}\)\s?-\s?\(\d{4}\)/,
];

/**
 * Detect if filename looks like a TV show
 */
export function isTVShowFilename(title: string): boolean {
	return TV_PATTERNS.some((pattern) => pattern.test(title));
}
