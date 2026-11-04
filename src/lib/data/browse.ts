import { createInfiniteQuery, createMutation } from "@tanstack/svelte-query";
import { invalidate } from "$app/navigation";
import { type CatalogFilters, DEFAULT_CATALOG_FILTERS, serializeCatalogSearch } from "$lib/data/search";
import type { BrowseItem, SeasonSummary } from "$lib/server/tmdb";
import type { Media } from "$lib/types";
import { apiRequest, queryClient } from "./client";
import { prefetchProwlarrStatus } from "./prowlarr";

export type { BrowseItem, SeasonSummary } from "$lib/server/tmdb";

const BROWSE_STALE_TIME_MS = 30 * 60 * 1000;
const RESOLVE_STALE_TIME_MS = 24 * 60 * 60 * 1000;
const SEASONS_STALE_TIME_MS = 60 * 60 * 1000;
const IMAGE_PRELOAD_COUNT = 18;

const browseKeys = {
	infinite: (filters: CatalogFilters) => ["browse", "infinite", filters] as const,
	details: (tmdbIds: number[]) => ["browse", "details", ...tmdbIds.toSorted()] as const,
	resolve: (tmdbId: number) => ["browse", "resolve", tmdbId] as const,
	seasons: (tmdbId: number) => ["browse", "seasons", tmdbId] as const,
};

export interface BrowseResponse {
	items: BrowseItem[];
	page: number;
	totalPages: number;
}

export interface ResolveResponse {
	success: boolean;
	error?: string;
	message?: string;
	torrent?: {
		magnetLink: string;
	};
}

export interface BrowseDetailItem {
	tmdbId: number;
	imdbId: string | null;
	certification: string | null;
	magnetLink?: string;
}

interface BrowseDetailsResponse {
	details: BrowseDetailItem[];
}

export interface SeasonsResponse {
	seasons: SeasonSummary[];
}

interface ResolveInput {
	imdbId: string | null;
	tmdbId: number;
	title: string;
	year: number | null;
}

function fetchBrowseDetails(items: { tmdbId: number; mediaType: "movie" | "show" }[]): Promise<BrowseDetailsResponse> {
	if (items.length === 0) {
		return Promise.resolve({ details: [] });
	}
	return apiRequest("/api/browse/details", "Failed to fetch browse details", {
		method: "POST",
		json: { items },
	});
}

export function fetchBrowse(filters: CatalogFilters, page = 1): Promise<BrowseResponse> {
	const params = serializeCatalogSearch({
		query: "",
		page,
		filters: { ...filters, scope: "catalog" },
	});
	params.delete("scope");
	return apiRequest(`/api/browse?${params}`, "Failed to fetch browse titles");
}

export function resolveTorrent(item: ResolveInput): Promise<ResolveResponse> {
	return apiRequest("/api/browse/resolve", "Failed to resolve torrent", {
		method: "POST",
		json: item,
	});
}

export function fetchSeasons(tmdbId: number): Promise<SeasonsResponse> {
	return apiRequest(`/api/browse/seasons/${tmdbId}`, "Failed to fetch seasons");
}

export function createBrowseInfiniteQuery(filters: () => CatalogFilters, enabled: () => boolean) {
	return createInfiniteQuery(() => ({
		queryKey: browseKeys.infinite(filters()),
		queryFn: ({ pageParam }) => fetchBrowse(filters(), pageParam),
		initialPageParam: 1,
		getNextPageParam: (lastPage: BrowseResponse) =>
			lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
		enabled: enabled(),
		staleTime: BROWSE_STALE_TIME_MS,
	}));
}

export function fetchBrowseDetailsCached(
	items: { tmdbId: number; mediaType: "movie" | "show" }[]
): Promise<BrowseDetailsResponse> {
	return queryClient.fetchQuery({
		queryKey: browseKeys.details(items.map((item) => item.tmdbId)),
		queryFn: () => fetchBrowseDetails(items),
		staleTime: BROWSE_STALE_TIME_MS,
	});
}

export function resolveTorrentCached(item: ResolveInput): Promise<ResolveResponse> {
	return queryClient.fetchQuery({
		queryKey: browseKeys.resolve(item.tmdbId),
		queryFn: () => resolveTorrent(item),
		staleTime: RESOLVE_STALE_TIME_MS,
	});
}

export function fetchSeasonsCached(tmdbId: number): Promise<SeasonsResponse> {
	return queryClient.fetchQuery({
		queryKey: browseKeys.seasons(tmdbId),
		queryFn: () => fetchSeasons(tmdbId),
		staleTime: SEASONS_STALE_TIME_MS,
	});
}

function preloadImages(items: { posterUrl: string | null }[]): void {
	const urls = items
		.slice(0, IMAGE_PRELOAD_COUNT)
		.map((item) => item.posterUrl)
		.filter((url): url is string => url !== null);
	const load = () => {
		for (const url of urls) {
			const image = new Image();
			image.src = url;
		}
	};
	if (typeof requestIdleCallback === "function") {
		requestIdleCallback(load);
	} else {
		setTimeout(load, 0);
	}
}

function prefetchBrowse(filters: CatalogFilters = DEFAULT_CATALOG_FILTERS): void {
	queryClient
		.prefetchInfiniteQuery({
			queryKey: browseKeys.infinite(filters),
			queryFn: ({ pageParam }) => fetchBrowse(filters, pageParam),
			initialPageParam: 1,
			staleTime: BROWSE_STALE_TIME_MS,
		})
		.then(() => {
			const data = queryClient.getQueryData<{ pages: BrowseResponse[] }>(browseKeys.infinite(filters));
			const firstPage = data?.pages[0];
			if (firstPage) {
				preloadImages(firstPage.items);
			}
		});
}

export function prefetchBrowseData(): void {
	prefetchProwlarrStatus();
	prefetchBrowse();
}

interface AddFromBrowseMagnetParams {
	mode?: "magnet";
	magnetLink: string;
	title: string;
	year?: number | null;
	tmdbId?: number;
}

interface AddSeasonFromBrowseParams {
	mode: "browse-season";
	tmdbId: number;
	seasonNumber: number;
	title: string;
	year?: number | null;
	posterUrl?: string | null;
	backdropUrl?: string | null;
	overview?: string | null;
	genres?: string[] | null;
	certification?: string | null;
}

export type AddFromBrowseParams = AddFromBrowseMagnetParams | AddSeasonFromBrowseParams;
export type AddFromBrowseResponse = Media | undefined;

export function createAddFromBrowseMutation() {
	return createMutation<AddFromBrowseResponse, Error, AddFromBrowseParams>(() => ({
		mutationFn: (params) =>
			apiRequest("/api/media", "Failed to add to library", {
				method: "POST",
				json: params,
			}),
		onSuccess: async () => {
			await invalidate("/api/media");
		},
	}));
}
