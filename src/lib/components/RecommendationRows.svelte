<script lang="ts">
    import { createBrowseActions } from "$lib/browse-actions.svelte";
    import CardSkeleton from "$lib/components/CardSkeleton.svelte";
    import TorrentCard from "$lib/components/TorrentCard.svelte";
    import { createRecommendationsQuery } from "$lib/data/browse";

    let {
        actions,
    }: {
        /** The browse page's actions, so its grid and these rows share one adding state. */
        actions: ReturnType<typeof createBrowseActions>;
    } = $props();

    const query = createRecommendationsQuery();
    const rows = $derived(query.data?.rows ?? []);
</script>

{#if query.isLoading}
    <section class="mb-10" aria-busy="true">
        <div class="mb-3 h-6 w-48 rounded bg-white/5"></div>
        <div class="-mx-2 flex gap-4 overflow-hidden px-2 pb-4 pt-2">
            {#each { length: 6 } as _}
                <div class="w-36 shrink-0 sm:w-44">
                    <CardSkeleton />
                </div>
            {/each}
        </div>
    </section>
{:else}
    {#each rows as row (row.title)}
        <section class="mb-10">
            <div class="mb-3 flex items-end justify-between">
                <h2 class="text-lg font-semibold text-white">{row.title}</h2>
            </div>
            <div class="-mx-2 flex gap-4 overflow-x-auto px-2 pb-4 pt-2 no-scrollbar">
                {#each row.items as item (`${item.mediaType}:${item.tmdbId}`)}
                    <div class="w-36 shrink-0 sm:w-44">
                        <TorrentCard
                            {item}
                            onAddToLibrary={actions.addToLibrary}
                            onWatchNow={actions.watchNow}
                            onPrefetch={actions.prefetch}
                            onSelectSeason={actions.selectSeason}
                            onPrefetchSeasons={actions.prefetchSeasons}
                            isAdding={actions.isAdding(item.tmdbId)}
                            seasons={actions.seasonsFor(item.tmdbId)}
                            seasonsLoading={actions.isLoadingSeasons(item.tmdbId)}
                        />
                    </div>
                {/each}
            </div>
        </section>
    {/each}
{/if}
