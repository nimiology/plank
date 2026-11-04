import { toast } from "svelte-sonner";
import { goto } from "$app/navigation";
import {
	type BrowseItem,
	createAddFromBrowseMutation,
	fetchSeasonsCached,
	resolveTorrentCached,
	type SeasonSummary,
} from "$lib/data/browse";
import type { CatalogSeason } from "$lib/types";

/**
 * Add, watch and season actions for TorrentCard, shared by the browse grid and the recommendation rows.
 * Call it during component setup, since it creates a mutation.
 */
export function createBrowseActions() {
	const addToLibraryMutation = createAddFromBrowseMutation();
	let addingItems = $state<Set<number>>(new Set());
	// Local reactive cache for the UI to bind to; QueryClient handles the network caching
	let seasonsCache = $state<Map<number, CatalogSeason[]>>(new Map());
	let seasonsLoading = $state<Set<number>>(new Set());

	function startAdding(tmdbId: number): boolean {
		if (addingItems.has(tmdbId)) {
			return false;
		}
		addingItems = new Set(addingItems).add(tmdbId);
		return true;
	}

	function stopAdding(tmdbId: number) {
		const updated = new Set(addingItems);
		updated.delete(tmdbId);
		addingItems = updated;
	}

	// Get magnet link through the shared query cache
	async function getMagnetLink(item: BrowseItem): Promise<string | null> {
		if (item.magnetLink) {
			return item.magnetLink;
		}

		try {
			const result = await resolveTorrentCached({
				imdbId: item.imdbId,
				tmdbId: item.tmdbId,
				title: item.title,
				year: item.year,
			});

			if (!(result.success && result.torrent)) {
				console.error("Failed to resolve torrent:", result.message || result.error);
				return null;
			}

			return result.torrent.magnetLink;
		} catch (err) {
			console.error("Failed to resolve torrent:", err);
			return null;
		}
	}

	async function addToLibrary(item: BrowseItem) {
		if (!startAdding(item.tmdbId)) {
			return;
		}

		try {
			const magnetLink = await getMagnetLink(item);
			if (!magnetLink) {
				toast.error("No magnet link found for this title");
				throw new Error("Could not resolve magnet link");
			}

			await addToLibraryMutation.mutateAsync({
				magnetLink,
				title: item.title,
				year: item.year,
				tmdbId: item.tmdbId,
			});
			toast.success("Added to library");
		} catch (err) {
			console.error("Failed to add to library:", err);
			if (err instanceof Error && err.message !== "Could not resolve magnet link") {
				toast.error("Failed to add to library. No valid magnet link found");
			}
		} finally {
			stopAdding(item.tmdbId);
		}
	}

	async function watchNow(item: BrowseItem) {
		if (!startAdding(item.tmdbId)) {
			return;
		}

		try {
			const magnetLink = await getMagnetLink(item);
			if (!magnetLink) {
				toast.error("No magnet link found for this title");
				throw new Error("Could not resolve magnet link");
			}

			const media = await addToLibraryMutation.mutateAsync({
				magnetLink,
				title: item.title,
				year: item.year,
				tmdbId: item.tmdbId,
			});
			if (media) {
				goto(`/watch/${media.id}`);
			}
		} catch (err) {
			console.error("Failed to add and watch:", err);
			if (err instanceof Error && err.message !== "Could not resolve magnet link") {
				toast.error("Failed to start playback");
			}
		} finally {
			stopAdding(item.tmdbId);
		}
	}

	// Prefetch magnet link on hover; the shared cache handles deduplication
	function prefetch(item: BrowseItem) {
		getMagnetLink(item);
	}

	async function getSeasons(item: BrowseItem): Promise<void> {
		if (seasonsCache.has(item.tmdbId)) {
			return;
		}

		seasonsLoading = new Set(seasonsLoading).add(item.tmdbId);

		try {
			const response = await fetchSeasonsCached(item.tmdbId);

			const seasonData: CatalogSeason[] = response.seasons.map((s: SeasonSummary) => ({
				seasonNumber: s.seasonNumber,
				name: s.name,
				episodeCount: s.episodeCount,
			}));
			seasonsCache = new Map(seasonsCache).set(item.tmdbId, seasonData);
		} catch (err) {
			console.error("Failed to fetch seasons:", err);
		} finally {
			const updated = new Set(seasonsLoading);
			updated.delete(item.tmdbId);
			seasonsLoading = updated;
		}
	}

	// Prefetch seasons for a TV show on hover - fire and forget
	function prefetchSeasons(item: BrowseItem) {
		if (item.mediaType !== "show") {
			return;
		}
		getSeasons(item);
	}

	// Queue metadata-first episode downloads for one season
	async function selectSeason(item: BrowseItem, seasonNumber: number) {
		if (!startAdding(item.tmdbId)) {
			return;
		}

		try {
			await addToLibraryMutation.mutateAsync({
				mode: "browse-season",
				title: item.title,
				year: item.year,
				tmdbId: item.tmdbId,
				seasonNumber,
				posterUrl: item.posterUrl,
				backdropUrl: item.backdropUrl,
				overview: item.overview,
				genres: item.genres,
				certification: item.certification,
			});
			toast.success(`Season ${seasonNumber} queued`);
		} catch (err) {
			console.error("Failed to add season to library:", err);
			toast.error("Failed to add season");
		} finally {
			stopAdding(item.tmdbId);
		}
	}

	return {
		addToLibrary,
		watchNow,
		prefetch,
		prefetchSeasons,
		selectSeason,
		isAdding: (tmdbId: number) => addingItems.has(tmdbId),
		seasonsFor: (tmdbId: number) => seasonsCache.get(tmdbId) ?? [],
		isLoadingSeasons: (tmdbId: number) => seasonsLoading.has(tmdbId),
	};
}
