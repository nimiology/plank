<script lang="ts">
    import { ChevronDown, Download, Loader2, Play, Plus } from "@lucide/svelte";
    import { DropdownMenu, Progress } from "bits-ui";
    import { onDestroy } from "svelte";
    import type { BrowseItem } from "$lib/server/tmdb";
    import type { CatalogSeason } from "$lib/types";
    import { cn, tmdbImage } from "$lib/utils";
    import Button from "./ui/Button.svelte";
    import Tip from "./ui/Tip.svelte";
    import Tv from "./ui/Tv.svelte";

    let {
        item,
        onAddToLibrary,
        onWatchNow,
        onPrefetch,
        onSelectSeason,
        onPrefetchSeasons,
        isAdding = false,
        seasons = [],
        seasonsLoading = false,
        eagerLoad = false,
    }: {
        item: BrowseItem;
        onAddToLibrary?: (item: BrowseItem) => void;
        onWatchNow?: (item: BrowseItem) => void;
        onPrefetch?: (item: BrowseItem) => void;
        onSelectSeason?: (item: BrowseItem, seasonNumber: number) => void;
        onPrefetchSeasons?: (item: BrowseItem) => void;
        isAdding?: boolean;
        seasons?: CatalogSeason[];
        seasonsLoading?: boolean;
        /** Load image eagerly (for above-the-fold cards) */
        eagerLoad?: boolean;
    } = $props();

    const isTvShow = $derived(item.mediaType === "show");
    // Check if seasons are already loaded (from parent's cache)
    const hasSeasonsLoaded = $derived(seasons.length > 0);

    let isMobileActive = $state(false);
    let hasPrefetched = $state(false);
    let prefetchTimeout: ReturnType<typeof setTimeout> | null = null;
    let seasonsPrefetchTimeout: ReturnType<typeof setTimeout> | null = null;
    let seasonMenuOpen = $state(false);

    const PREFETCH_DELAY = 300; // ms to wait before prefetching
    const TORRENT_PREFETCH_DELAY = 300; // ms to wait before prefetching torrent

    function handleClick(e: Event) {
        // Don't toggle if we clicked an interactive element inside
        if ((e.target as HTMLElement).closest("button, a")) {
            return;
        }
        isMobileActive = !isMobileActive;
    }

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            isMobileActive = !isMobileActive;
        }
    }

    function handleMouseEnter() {
        // Only prefetch torrent for movies (not TV shows)
        if (!(isTvShow || hasPrefetched)) {
            const needsTorrentPrefetch = item.needsResolve && !item.magnetLink;
            if (needsTorrentPrefetch) {
                if (prefetchTimeout) {
                    clearTimeout(prefetchTimeout);
                }
                prefetchTimeout = setTimeout(() => {
                    hasPrefetched = true;
                    onPrefetch?.(item);
                    prefetchTimeout = null;
                }, TORRENT_PREFETCH_DELAY);
            }
        }

        // Prefetch seasons for TV shows (check hasSeasonsLoaded instead of local state)
        if (isTvShow && !hasSeasonsLoaded && !seasonsLoading && onPrefetchSeasons) {
            if (seasonsPrefetchTimeout) {
                clearTimeout(seasonsPrefetchTimeout);
            }
            seasonsPrefetchTimeout = setTimeout(() => {
                onPrefetchSeasons(item);
                seasonsPrefetchTimeout = null;
            }, PREFETCH_DELAY);
        }
    }

    function handleMouseLeave() {
        // Cancel prefetch if user leaves before delay completes
        if (prefetchTimeout) {
            clearTimeout(prefetchTimeout);
            prefetchTimeout = null;
        }
        if (seasonsPrefetchTimeout) {
            clearTimeout(seasonsPrefetchTimeout);
            seasonsPrefetchTimeout = null;
        }
    }

    function handleAddToLibrary(e: Event) {
        e.stopPropagation();
        onAddToLibrary?.(item);
    }

    function handleWatchNow(e: Event) {
        e.stopPropagation();
        onWatchNow?.(item);
    }

    function handleSeasonMenuOpen(open: boolean) {
        const shouldFetchSeasons = open && !(hasSeasonsLoaded || seasonsLoading) && onPrefetchSeasons;
        if (shouldFetchSeasons) {
            onPrefetchSeasons(item);
        }
    }

    function handleSelectSeason(seasonNumber: number) {
        onSelectSeason?.(item, seasonNumber);
    }

    const isDisabled = $derived(isAdding);

    let progressState = $state<"idle" | "adding" | "completing">("idle");
    let progressWidth = $state(0);
    let transitionDuration = $state(0);

    $effect(() => {
        if (isAdding) {
            if (progressState === "idle") {
                progressState = "adding";
                progressWidth = 0;
                transitionDuration = 0;

                // Allow DOM to update with 0% width first
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        progressWidth = 90;
                        transitionDuration = 15_000;
                    });
                });
            }
        } else if (progressState === "adding") {
            progressState = "completing";
            progressWidth = 100;
            transitionDuration = 200; // Fast finish

            setTimeout(() => {
                progressState = "idle";
                progressWidth = 0;
                transitionDuration = 0;
            }, 500); // Wait for completion animation
        }
    });
    onDestroy(() => {
        if (prefetchTimeout) {
            clearTimeout(prefetchTimeout);
        }
        if (seasonsPrefetchTimeout) {
            clearTimeout(seasonsPrefetchTimeout);
        }
    });
</script>

<div
    onclick={handleClick}
    onkeydown={handleKeydown}
    onmouseenter={handleMouseEnter}
    onmouseleave={handleMouseLeave}
    onfocus={handleMouseEnter}
    onblur={handleMouseLeave}
    role="button"
    tabindex="0"
    class="group relative aspect-2/3 cursor-pointer rounded-xl border border-border/50 bg-card shadow-lg outline-none transition-[border-color,box-shadow] duration-300 hover:z-20 hover:border-primary/50 hover:shadow-xl"
>
    <div class="absolute inset-0 overflow-hidden rounded-xl">
        {#if item.voteAverage && item.voteAverage > 0}
            <div
                class={cn(
                    "absolute right-2 top-2 z-10 flex items-center gap-1 rounded bg-black/80 px-2 py-0.5 text-xs font-medium text-yellow-400",
                    isMobileActive || seasonMenuOpen ? "hidden" : "group-hover:hidden",
                )}
            >
                <span class="text-yellow-400">&#9733;</span>
                {item.voteAverage.toFixed(1)}
            </div>
        {/if}

        {#if item.mediaType === "show"}
            <div
                class={cn(
                    "absolute left-2 top-2 z-10 flex items-center gap-1 rounded bg-primary/90 px-2 py-0.5 text-xs text-primary-foreground",
                    isMobileActive || seasonMenuOpen ? "hidden" : "group-hover:hidden",
                )}
            >
                <Tv size={12} />
                TV
            </div>
        {/if}

        {#if item.posterUrl}
            <img
                src={tmdbImage(item.posterUrl)}
                alt={item.title}
                class={cn(
                    "h-full w-full object-cover transition-all duration-300 group-hover:scale-105 group-hover:blur-sm",
                    isMobileActive || seasonMenuOpen ? "scale-105 blur-sm" : "",
                )}
                loading={eagerLoad ? "eager" : "lazy"}
                decoding={eagerLoad ? "sync" : "async"}
            >
        {:else}
            <div class="flex h-full w-full items-center justify-center bg-accent text-muted-foreground">
                <span class="px-4 text-center text-sm">{item.title}</span>
            </div>
        {/if}

        {#if progressState !== "idle"}
            <Progress.Root
                value={progressWidth}
                max={100}
                aria-label="Add progress"
                class="absolute bottom-0 left-0 z-20 h-1 w-full"
            >
                <div
                    class="h-full bg-red-600 transition-all ease-out"
                    style:width="{progressWidth}%"
                    style:transition-duration="{transitionDuration}ms"
                ></div>
            </Progress.Root>
        {/if}

        <div
            class={cn(
                "absolute inset-0 flex flex-col justify-between rounded-xl bg-black/60 p-4 backdrop-blur-sm transition-all duration-300 ease-out",
                isMobileActive || seasonMenuOpen
                    ? "pointer-events-auto translate-y-0 opacity-100"
                    : "pointer-events-none translate-y-2 opacity-0 group-hover:pointer-events-auto group-hover:translate-y-0 group-hover:opacity-100",
            )}
        >
            <div class="flex min-h-0 flex-1 flex-col space-y-2 overflow-hidden">
                <h4 class="shrink-0 text-lg font-bold leading-tight text-white">{item.title}</h4>

                <div class="flex shrink-0 items-center gap-2 text-xs text-zinc-300">
                    {#if item.year}
                        <span>{item.year}</span>
                    {/if}
                    {#if item.certification}
                        <span class="rounded bg-white/10 px-1 text-[10px] font-medium">{item.certification}</span>
                    {/if}
                    {#if item.voteAverage && item.voteAverage > 0}
                        <span class="flex items-center gap-0.5 text-yellow-400">
                            &#9733; {item.voteAverage.toFixed(1)}
                        </span>
                    {/if}
                </div>

                {#if item.genres.length > 0}
                    <div class="flex shrink-0 flex-wrap gap-1 pt-1">
                        {#each item.genres.slice(0, 2) as genre}
                            <span class="rounded bg-zinc-700/80 px-1.5 py-0.5 text-[10px] text-zinc-300">
                                {genre}
                            </span>
                        {/each}
                    </div>
                {/if}

                {#if item.overview}
                    <p class="overflow-y-auto pr-1 text-xs leading-relaxed text-zinc-400">{item.overview}</p>
                {/if}
            </div>

            <div class="relative flex shrink-0 gap-2 pt-2">
                {#if isTvShow}
                    <DropdownMenu.Root bind:open={seasonMenuOpen} onOpenChange={handleSeasonMenuOpen}>
                        <DropdownMenu.Trigger
                            disabled={isDisabled}
                            class="inline-flex h-9 flex-1 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                            aria-label="Add season"
                        >
                            <Plus class="mr-1 h-3 w-3" />
                            Add Season
                            <ChevronDown
                                class="ml-1 h-3 w-3 transition-transform {seasonMenuOpen ? 'rotate-180' : ''}"
                            />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                            <DropdownMenu.Content
                                side="bottom"
                                align="start"
                                sideOffset={8}
                                class="z-50 max-h-96 w-72 overflow-y-auto rounded-xl border border-white/10 bg-black/95 p-1.5 text-white shadow-2xl backdrop-blur-xl focus:outline-none"
                            >
                                {#if seasonsLoading}
                                    <div
                                        class="flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground"
                                    >
                                        <Loader2 class="h-4 w-4 animate-spin" />
                                        Loading seasons...
                                    </div>
                                {:else if seasons.length === 0}
                                    <div class="px-4 py-5 text-center text-sm text-muted-foreground">
                                        No seasons available
                                    </div>
                                {:else}
                                    {#each seasons as season}
                                        <DropdownMenu.Item
                                            onSelect={() => handleSelectSeason(season.seasonNumber)}
                                            class="group flex min-h-11 cursor-default select-none items-center gap-3 rounded-lg px-3 py-2 text-left outline-none data-highlighted:bg-white/10"
                                        >
                                            <div class="min-w-0 flex-1">
                                                <div class="truncate text-sm font-medium">
                                                    {season.name || `Season ${season.seasonNumber}`}
                                                </div>
                                                {#if season.episodeCount > 0}
                                                    <div class="text-xs text-muted-foreground">
                                                        {season.episodeCount} episodes
                                                    </div>
                                                {/if}
                                            </div>
                                            <Download
                                                class="h-4 w-4 text-primary opacity-0 transition-opacity group-data-highlighted:opacity-100"
                                            />
                                        </DropdownMenu.Item>
                                    {/each}
                                {/if}
                            </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                {:else}
                    <Tip text="Add to Library">
                        {#snippet children(tipProps)}
                            <Button
                                {...tipProps}
                                size="sm"
                                variant="secondary"
                                class="flex-1 text-xs"
                                onclick={handleAddToLibrary}
                                disabled={isDisabled}
                            >
                                <Plus class="mr-1 h-3 w-3" />
                                Add
                            </Button>
                        {/snippet}
                    </Tip>
                    <Tip text="Watch Now">
                        {#snippet children(tipProps)}
                            <Button
                                {...tipProps}
                                size="sm"
                                class="flex-1 text-xs"
                                onclick={handleWatchNow}
                                disabled={isDisabled}
                            >
                                <Play class="mr-1 h-3 w-3 fill-current" />
                                Watch
                            </Button>
                        {/snippet}
                    </Tip>
                {/if}
            </div>
        </div>
    </div>
</div>
