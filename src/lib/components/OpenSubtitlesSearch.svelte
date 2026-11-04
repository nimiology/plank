<script lang="ts">
    import { Check, Download, Ear, Loader, Shield, Star } from "@lucide/svelte";
    import { onDestroy } from "svelte";
    import Button from "$lib/components/ui/Button.svelte";
    import Scroller from "$lib/components/ui/Scroller.svelte";
    import SelectField from "$lib/components/ui/SelectField.svelte";
    import Tip from "$lib/components/ui/Tip.svelte";
    import { LANGUAGES } from "$lib/constants";
    import { createDownloadSubtitleMutation, searchOpenSubtitles } from "$lib/data/media";
    import type { OpenSubtitleResult, SubtitleTrackResponse } from "$lib/types";

    let {
        mediaId,
        seasonNumber,
        episodeNumber,
        onDownloaded,
        portalTarget,
    }: {
        mediaId: string;
        seasonNumber?: number;
        episodeNumber?: number | null;
        onDownloaded?: (track: SubtitleTrackResponse) => void;
        portalTarget?: HTMLElement;
    } = $props();

    let results: OpenSubtitleResult[] = $state([]);
    let searching = $state(false);
    let searchError = $state("");
    let downloadError = $state("");
    let selectedLanguage = $state("fa");
    let downloadingIds = $state<Set<string>>(new Set());
    let downloadedIds = $state<Set<string>>(new Set());

    const downloadMutation = createDownloadSubtitleMutation();
    const languageOptions = LANGUAGES.map((language) => ({ value: language.code, label: language.name }));
    let searchRequestId = 0;

    async function performSearch() {
        const requestId = ++searchRequestId;
        searching = true;
        searchError = "";
        downloadError = "";
        results = [];

        try {
            const matches = await searchOpenSubtitles(mediaId, {
                languages: selectedLanguage,
                seasonNumber,
                episodeNumber,
            });
            if (requestId === searchRequestId) {
                results = matches;
            }
        } catch (err) {
            if (requestId === searchRequestId) {
                searchError = err instanceof Error ? err.message : "Search failed";
            }
        } finally {
            if (requestId === searchRequestId) {
                searching = false;
            }
        }
    }

    async function handleDownload(result: OpenSubtitleResult) {
        if (downloadingIds.has(result.id) || downloadedIds.has(result.id)) {
            return;
        }

        downloadingIds = new Set([...downloadingIds, result.id]);
        downloadError = "";

        try {
            const track = await downloadMutation.mutateAsync({
                mediaId,
                fileId: result.fileId,
                language: result.language,
            });
            downloadedIds = new Set([...downloadedIds, result.id]);
            onDownloaded?.(track);
        } catch (err) {
            downloadError = err instanceof Error ? err.message : "Download failed. Please try again.";
        } finally {
            const next = new Set(downloadingIds);
            next.delete(result.id);
            downloadingIds = next;
        }
    }

    function formatDownloadCount(count: number): string {
        if (count >= 1_000_000) {
            return `${(count / 1_000_000).toFixed(1)}M`;
        }
        if (count >= 1000) {
            return `${(count / 1000).toFixed(1)}K`;
        }
        return String(count);
    }

    // Search on open and whenever the selected language or media changes.
    $effect(() => {
        performSearch();
    });

    onDestroy(() => {
        searchRequestId++;
    });
</script>

<div class="space-y-4 mt-2">
    <SelectField
        bind:value={selectedLanguage}
        items={languageOptions}
        ariaLabel="Caption language"
        class="w-full"
        {portalTarget}
    />

    <!-- Error state -->
    {#if searchError || downloadError}
        <div
            role="alert"
            class="px-4 py-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive"
        >
            {searchError || downloadError}
        </div>
    {/if}

    <!-- Results -->
    <Scroller class="max-h-[min(24rem,45dvh)] -mx-2 px-2">
        <div class="space-y-1">
            {#if searching}
                <div role="status" class="flex items-center justify-center py-12">
                    <Loader class="w-6 h-6 animate-spin text-muted-foreground" />
                    <span class="sr-only">Searching subtitles…</span>
                </div>
            {:else if results.length === 0 && !searchError}
                <div class="text-center py-12 text-muted-foreground text-sm">
                    No subtitles found. Try another language.
                </div>
            {:else}
                {#each results as result (result.id)}
                    <div
                        class="flex items-start gap-3 p-3 rounded-lg border border-border/50 hover:border-border transition-colors bg-card/50"
                    >
                        <!-- Main info -->
                        <div class="flex-1 min-w-0 space-y-1.5">
                            <!-- Title line with tags -->
                            <div class="flex items-center gap-2 flex-wrap">
                                <span class="text-sm font-medium text-white truncate"> {result.languageName} </span>

                                {#if result.hearingImpaired}
                                    <Tip text="Hearing Impaired">
                                        {#snippet children(tipProps)}
                                            <button
                                                {...tipProps}
                                                type="button"
                                                class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 cursor-default"
                                            >
                                                <Ear class="w-3 h-3 inline-block" /> HI
                                            </button>
                                        {/snippet}
                                    </Tip>
                                {/if}

                                {#if result.fromTrusted}
                                    <Tip text="Trusted uploader">
                                        {#snippet children(tipProps)}
                                            <button
                                                {...tipProps}
                                                type="button"
                                                class="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 cursor-default"
                                            >
                                                <Shield class="w-3 h-3 inline-block" /> Trusted
                                            </button>
                                        {/snippet}
                                    </Tip>
                                {/if}

                                {#if result.aiTranslated}
                                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">
                                        AI
                                    </span>
                                {/if}
                            </div>

                            <!-- Release name -->
                            <p class="text-xs text-muted-foreground truncate" title={result.release}>
                                {result.release || result.fileName}
                            </p>

                            <!-- Stats line -->
                            <div class="flex items-center gap-3 text-[11px] text-muted-foreground">
                                <span class="flex items-center gap-1">
                                    <Download class="w-3 h-3" />
                                    {formatDownloadCount(result.downloadCount)}
                                </span>
                                {#if result.ratings > 0}
                                    <span class="flex items-center gap-1">
                                        <Star class="w-3 h-3" />
                                        {result.ratings.toFixed(1)}
                                    </span>
                                {/if}
                                {#if result.fps > 0}
                                    <span>{result.fps} fps</span>
                                {/if}
                            </div>
                        </div>

                        <!-- Download button -->
                        <div class="shrink-0 pt-1">
                            {#if downloadedIds.has(result.id)}
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    class="h-8 w-8 text-green-400"
                                    aria-label="Subtitle downloaded"
                                    disabled
                                >
                                    <Check class="w-4 h-4" />
                                </Button>
                            {:else if downloadingIds.has(result.id)}
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    class="h-8 w-8"
                                    aria-label="Downloading subtitle"
                                    disabled
                                >
                                    <Loader class="w-4 h-4 animate-spin" />
                                </Button>
                            {:else}
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    class="h-8 w-8 text-muted-foreground hover:text-white"
                                    onclick={() => handleDownload(result)}
                                    disabled={result.fileId <= 0}
                                    aria-label="Download {result.languageName} subtitles: {result.release || result.fileName}"
                                >
                                    <Download class="w-4 h-4" />
                                </Button>
                            {/if}
                        </div>
                    </div>
                {/each}
            {/if}
        </div>
    </Scroller>
</div>
