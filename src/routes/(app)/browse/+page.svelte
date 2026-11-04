<script lang="ts">
    import { Trophy } from "@lucide/svelte";
    import { untrack } from "svelte";
    import { toast } from "svelte-sonner";
    import { goto } from "$app/navigation";
    import CardSkeleton from "$lib/components/CardSkeleton.svelte";
    import CatalogFilterButton from "$lib/components/CatalogFilterButton.svelte";
    import ProwlarrSetup from "$lib/components/ProwlarrSetup.svelte";
    import TorrentCard from "$lib/components/TorrentCard.svelte";
    import Button from "$lib/components/ui/Button.svelte";
    import {
        type BrowseDetailItem,
        type BrowseItem,
        createAddFromBrowseMutation,
        createBrowseInfiniteQuery,
        fetchBrowseDetailsCached,
        fetchSeasonsCached,
        resolveTorrentCached,
        type SeasonSummary,
    } from "$lib/data/browse";
    import { createProwlarrStatusQuery } from "$lib/data/prowlarr";
    import { type CatalogFilters, serializeCatalogSearch } from "$lib/data/search";
    import type { CatalogSeason } from "$lib/types";
    import type { PageData } from "./$types";

    let { data } = $props<{ data: PageData }>();
    const addToLibraryMutation = createAddFromBrowseMutation();
    let filters = $state<CatalogFilters>(
        untrack(() => ({ ...data.request.filters, genres: [...data.request.filters.genres] }))
    );

    $effect(() => {
        filters = { ...data.request.filters, genres: [...data.request.filters.genres] };
    });

    async function applyFilters(nextFilters: CatalogFilters) {
        const params = serializeCatalogSearch({
            query: "",
            page: 1,
            filters: { ...nextFilters, scope: "catalog" },
        });
        params.delete("scope");
        await goto(`/browse?${params}`, { noScroll: true });
    }

    const prowlarrQuery = createProwlarrStatusQuery();
    const prowlarrReady = $derived(
        prowlarrQuery.isSuccess && prowlarrQuery.data?.configured && !prowlarrQuery.data?.needsSetup
    );
    const browseQuery = createBrowseInfiniteQuery(
        () => filters,
        () => Boolean(prowlarrReady)
    );

    // ==========================================================================
    // Lazy Detail Enrichment
    // ==========================================================================

    // Map of tmdbId -> enrichment data (imdbId, certification, magnetLink)
    let enrichmentMap = $state<Map<number, BrowseDetailItem>>(new Map());
    // Track which tmdbIds we've already requested enrichment for
    let enrichedIds = $state<Set<number>>(new Set());

    // Flatten and deduplicate raw items from all pages (before enrichment)
    const rawItems = $derived.by(() => {
        const pages = browseQuery.data?.pages ?? [];
        const seen = new Set<number>();

        return pages
            .flatMap((page) => page.items)
            .filter((item) => {
                if (seen.has(item.tmdbId)) {
                    return false;
                }
                seen.add(item.tmdbId);
                return true;
            });
    });

    // Trigger lazy enrichment whenever new items appear
    $effect(() => {
        const unenriched = rawItems.filter((item) => !enrichedIds.has(item.tmdbId));
        if (unenriched.length === 0) {
            return;
        }

        // Mark as requested immediately to prevent duplicate calls
        const newIds = new Set(enrichedIds);
        for (const item of unenriched) {
            newIds.add(item.tmdbId);
        }
        enrichedIds = newIds;

        // Fire the batch request (uses server-side in-memory cache for repeat items)
        const batch = unenriched.map((item) => ({
            tmdbId: item.tmdbId,
            mediaType: item.mediaType,
        }));
        fetchBrowseDetailsCached(batch).then((response) => {
            const updated = new Map(enrichmentMap);
            for (const detail of response.details) {
                updated.set(detail.tmdbId, detail);
            }
            enrichmentMap = updated;
        });
    });

    // Merge enrichment data into display items
    const displayItems = $derived.by(() => {
        const ctx = String(serializeCatalogSearch({ query: "", page: 1, filters }));

        return rawItems.map((item) => {
            const detail = enrichmentMap.get(item.tmdbId);
            if (detail) {
                return {
                    ...item,
                    imdbId: detail.imdbId ?? item.imdbId,
                    certification: detail.certification ?? item.certification,
                    magnetLink: detail.magnetLink ?? item.magnetLink,
                    needsResolve: !detail.magnetLink && item.needsResolve,
                    _key: `${ctx}-${item.tmdbId}`,
                };
            }
            return { ...item, _key: `${ctx}-${item.tmdbId}` };
        });
    });

    // UI State
    let addingItems = $state<Set<number>>(new Set());

    // TV show seasons state - keyed by TMDB ID
    // We keep a local reactive cache for the UI to bind to (passed to TorrentCard)
    // The data fetching uses QueryClient for network caching
    let seasonsCache = $state<Map<number, CatalogSeason[]>>(new Map());
    let seasonsLoading = $state<Set<number>>(new Set());

    // Load more trigger element
    let loadMoreTrigger: HTMLDivElement | null = $state(null);

    const hasMore = $derived(browseQuery.hasNextPage);
    const isFetchingMore = $derived(browseQuery.isFetchingNextPage);
    const isLoading = $derived(prowlarrQuery.isLoading || browseQuery.isLoading);

    // Intersection observer for infinite scroll
    $effect(() => {
        if (!loadMoreTrigger) {
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (entry.isIntersecting && hasMore && !isFetchingMore) {
                    browseQuery.fetchNextPage();
                }
            },
            { rootMargin: "300px" }
        );

        observer.observe(loadMoreTrigger);

        return () => observer.disconnect();
    });

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

    async function handleAddToLibrary(item: BrowseItem) {
        if (addingItems.has(item.tmdbId)) {
            return;
        }

        // Set adding state immediately to show UI spinner
        addingItems = new Set(addingItems).add(item.tmdbId);

        try {
            const magnetLink = await getMagnetLink(item);
            if (!magnetLink) {
                // If resolution fails, we must clear the adding state
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
            const updated = new Set(addingItems);
            updated.delete(item.tmdbId);
            addingItems = updated;
        }
    }

    async function handleWatchNow(item: BrowseItem) {
        if (addingItems.has(item.tmdbId)) {
            return;
        }

        // Set adding state immediately to show UI spinner
        addingItems = new Set(addingItems).add(item.tmdbId);

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
            const updated = new Set(addingItems);
            updated.delete(item.tmdbId);
            addingItems = updated;
        }
    }

    // Prefetch magnet link on hover - runs getMagnetLink in the background
    function handlePrefetch(item: BrowseItem) {
        // Fire and forget; the shared cache handles deduplication
        getMagnetLink(item);
    }

    // ==========================================================================
    // TV Show Season Handling
    // ==========================================================================

    // Get seasons for a TV show through the shared query cache
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
    function handlePrefetchSeasons(item: BrowseItem) {
        if (item.mediaType !== "show") {
            return;
        }
        // Fire and forget
        getSeasons(item);
    }

    // Get seasons for a specific item (from cache)
    function getSeasonsForItem(tmdbId: number): CatalogSeason[] {
        return seasonsCache.get(tmdbId) ?? [];
    }

    // Handle season selection - queue metadata-first episode downloads
    async function handleSelectSeason(item: BrowseItem, seasonNumber: number) {
        if (addingItems.has(item.tmdbId)) {
            return;
        }

        addingItems = new Set(addingItems).add(item.tmdbId);

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
            const updated = new Set(addingItems);
            updated.delete(item.tmdbId);
            addingItems = updated;
        }
    }
</script>

<div class="mx-auto min-h-screen max-w-7xl px-4 pb-28 pt-8 sm:pt-12">
    <header class="mb-6">
        <div class="flex items-end justify-between gap-4">
            <div>
                <h1 class="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Browse</h1>
            </div>
            <CatalogFilterButton {filters} onApply={applyFilters} class="shrink-0" />
        </div>
    </header>

    <!-- Content -->
    <div class="py-8">
        {#if prowlarrQuery.isLoading}
            <!-- Prowlarr status loading -->
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {#each { length: 12 } as _}
                    <CardSkeleton />
                {/each}
            </div>
        {:else if prowlarrQuery.isSuccess && (!prowlarrQuery.data.configured || prowlarrQuery.data.needsSetup)}
            <!-- Setup Instructions -->
            <ProwlarrSetup hasApiKey={prowlarrQuery.data.configured} />
        {:else if isLoading}
            <!-- Browse data loading -->
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {#each { length: 12 } as _}
                    <CardSkeleton />
                {/each}
            </div>
        {:else if displayItems.length === 0}
            <!-- Empty State -->
            <div class="text-center py-20 bg-muted/30 rounded-lg border border-dashed border-border mx-auto max-w-2xl">
                <Trophy class="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
                <h2 class="text-lg font-medium text-foreground mb-1">No content found</h2>
                <p class="text-muted-foreground">Check your indexer and Prowlarr configuration.</p>
            </div>
            {#if hasMore}
                <Button
                    variant="secondary"
                    class="mt-5 rounded-xl"
                    disabled={isFetchingMore}
                    onclick={() => browseQuery.fetchNextPage()}
                >
                    {isFetchingMore ? "Loading..." : "Load the next page"}
                </Button>
            {/if}
        {:else}
            <!-- Movie Grid -->
            <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                {#each displayItems as item, i (item._key)}
                    <TorrentCard
                        {item}
                        onAddToLibrary={handleAddToLibrary}
                        onWatchNow={handleWatchNow}
                        onPrefetch={handlePrefetch}
                        onSelectSeason={handleSelectSeason}
                        onPrefetchSeasons={handlePrefetchSeasons}
                        isAdding={addingItems.has(item.tmdbId)}
                        seasons={getSeasonsForItem(item.tmdbId)}
                        seasonsLoading={seasonsLoading.has(item.tmdbId)}
                        eagerLoad={i < 18}
                    />
                {/each}

                {#if isFetchingMore}
                    {#each { length: 5 } as _}
                        <CardSkeleton />
                    {/each}
                {/if}
            </div>

            <!-- Load More Trigger -->
            {#if hasMore}
                <div bind:this={loadMoreTrigger} class="flex justify-center py-12">
                    {#if !isFetchingMore}
                        <span class="h-6 block"></span>
                    {/if}
                </div>
            {/if}
        {/if}
    </div>
</div>
