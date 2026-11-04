<script lang="ts">
    import { ChevronRight, EllipsisVertical, Play, RotateCcw, Trash2 } from "@lucide/svelte";
    import { DropdownMenu } from "bits-ui";
    import SubtitleMenu from "$lib/components/SubtitleMenu.svelte";
    import Button from "$lib/components/ui/Button.svelte";
    import type { Media, QueueEpisode, SubtitleTrackResponse } from "$lib/types";
    import { canPlayEpisode, formatFileSize } from "$lib/utils";

    let {
        media,
        label = null,
        busy = false,
        subtitleTracks = [],
        status = null,
        progress = null,
        downloadSpeed = 0,
        peers = 0,
        totalSize = 0,
        transcodeProgress = 0,
        episodes = [],
        onPlay = null,
        onRedownload,
        onRemoveDownload = null,
        onAddSubtitles = null,
    }: {
        media: Media;
        /** Small line above the title, such as "Breaking Bad - S01E02". */
        label?: string | null;
        busy?: boolean;
        subtitleTracks?: SubtitleTrackResponse[];
        /** Live status. Falls back to the stored status of the media row. */
        status?: string | null;
        /** Live progress, from 0 to 1. When set, the row shows a progress bar. */
        progress?: number | null;
        downloadSpeed?: number;
        peers?: number;
        /** Size of the download in bytes; shown as "downloaded / total" when known. */
        totalSize?: number;
        /** Live finalization progress, from 0 to 1. */
        transcodeProgress?: number;
        /** Episodes that ride on this download. When set, the row gets an expander. */
        episodes?: QueueEpisode[];
        /** Leave unset to hide the play button. */
        onPlay?: ((item: Media) => void) | null;
        onRedownload: (item: Media) => void;
        /** Leave unset to hide the delete action. The menu then collapses to one redownload button. */
        onRemoveDownload?: ((item: Media) => void) | null;
        onAddSubtitles?: ((item: Media) => void) | null;
    } = $props();

    const rowStatus = $derived(status ?? media.status);
    const isRemoved = $derived(rowStatus === "removed");
    const thumbnail = $derived(media.stillPath ?? media.backdropUrl ?? media.posterUrl);
    const isFinalizing = $derived(rowStatus === "finalizing");
    const percent = $derived(Math.round((isFinalizing ? transcodeProgress : (progress ?? media.progress ?? 0)) * 100));
    const showBar = $derived(isFinalizing || (progress !== null && rowStatus === "downloading"));
    let episodesOpen = $state(false);

    function episodeLabel(episode: QueueEpisode): string {
        const season = String(episode.seasonNumber ?? 0).padStart(2, "0");
        const number = String(episode.episodeNumber ?? 0).padStart(2, "0");
        return `S${season}E${number}`;
    }

    function statusLabel(status: string | null): string {
        if (status === "complete" || media.filePath) {
            return "Downloaded";
        }
        switch (status) {
            case "removed":
                return "Removed";
            case "searching":
                return "Searching";
            case "downloading":
                return "Downloading";
            case "finalizing":
                return "Finalizing";
            case "not_found":
                return "Not Found";
            case "error":
                return "Error";
            default:
                return "Pending";
        }
    }

    function statusClass(status: string | null): string {
        if (status === "complete" || media.filePath) {
            return "bg-emerald-500 text-emerald-100";
        }
        switch (status) {
            case "removed":
                return "bg-rose-500 text-rose-100";
            case "downloading":
                return "bg-blue-500 text-blue-100";
            case "finalizing":
                return "bg-green-500 text-green-100";
            case "searching":
                return "bg-amber-500 text-amber-100";
            case "not_found":
            case "error":
                return "bg-red-500 text-red-100";
            default:
                return "bg-muted text-muted-foreground";
        }
    }

    function formatRuntime(minutes: number | null): string {
        if (!minutes) {
            return "";
        }
        if (minutes < 60) {
            return `${minutes}m`;
        }
        return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    }
</script>

<div
    class="rounded-2xl border bg-card/70 transition-colors {isRemoved
        ? 'border-rose-500/40 bg-rose-500/5'
        : 'border-border hover:border-primary/50'}"
>
    <div class="group flex gap-4 p-4">
        <div class="relative aspect-video w-32 shrink-0 overflow-hidden rounded bg-accent md:w-48">
            {#if thumbnail}
                <img src={thumbnail} alt={media.title} class="h-full w-full object-cover">
            {:else}
                <div class="flex h-full w-full items-center justify-center text-muted-foreground">
                    <Play class="h-8 w-8" />
                </div>
            {/if}
            <div class="absolute right-1 bottom-1 rounded px-1.5 py-0.5 text-[10px] {statusClass(rowStatus)}">
                {statusLabel(rowStatus)}
            </div>
        </div>

        <div class="flex min-w-0 flex-1 flex-col justify-between py-1">
            <div>
                {#if label}
                    <p class="truncate text-xs text-muted-foreground">{label}</p>
                {/if}
                <h3 class="line-clamp-1 text-base font-semibold md:text-lg">
                    {#if media.type === "episode" && media.episodeNumber !== null}
                        <span class="mr-1 text-muted-foreground">{media.episodeNumber}.</span>
                    {/if}
                    {media.title || `Episode ${media.episodeNumber}`}
                </h3>

                <div class="mt-1 flex items-center gap-3 text-xs text-muted-foreground md:text-sm">
                    {#if media.runtime}
                        <span>{formatRuntime(media.runtime)}</span>
                    {/if}
                    {#if media.airDate}
                        <span>• {media.airDate}</span>
                    {:else if media.year}
                        <span>• {media.year}</span>
                    {/if}
                </div>
            </div>

            <div class="mt-2 flex items-center justify-between md:mt-0">
                {#if media.overview}
                    <p class="hidden line-clamp-2 pr-4 text-xs text-muted-foreground md:block">{media.overview}</p>
                {/if}

                <div class="ml-auto flex shrink-0 items-center gap-1">
                    {#if onAddSubtitles}
                        <SubtitleMenu
                            mediaId={media.id}
                            tracks={subtitleTracks}
                            onAddSubtitles={() => onAddSubtitles(media)}
                            compact
                        />
                    {/if}
                    {#if onPlay}
                        <Button size="sm" disabled={!canPlayEpisode(media)} onclick={() => onPlay(media)}>
                            <Play class="mr-1 h-4 w-4 fill-current" />
                            Play
                        </Button>
                    {/if}
                    {#if onRemoveDownload}
                        <DropdownMenu.Root>
                            <DropdownMenu.Trigger
                                class="inline-flex h-10 w-10 items-center justify-center rounded-md text-white transition-colors hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                                aria-label="Download actions"
                            >
                                <EllipsisVertical class="h-4 w-4" />
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Portal>
                                <DropdownMenu.Content
                                    side="bottom"
                                    align="end"
                                    sideOffset={8}
                                    class="z-50 w-44 overflow-hidden rounded-xl border border-white/10 bg-black/95 p-1.5 text-gray-200 shadow-2xl backdrop-blur-xl focus:outline-none"
                                >
                                    <DropdownMenu.Item
                                        disabled={busy}
                                        onSelect={() => onRedownload(media)}
                                        class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm outline-none data-highlighted:bg-white/10 data-disabled:pointer-events-none data-disabled:opacity-50"
                                    >
                                        <RotateCcw class="h-4 w-4" />
                                        {busy ? "Working..." : "Redownload"}
                                    </DropdownMenu.Item>
                                    <DropdownMenu.Item
                                        disabled={busy || isRemoved}
                                        onSelect={() => onRemoveDownload(media)}
                                        class="flex h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 text-sm text-red-400 outline-none data-highlighted:bg-red-500/10 data-disabled:pointer-events-none data-disabled:opacity-50"
                                    >
                                        <Trash2 class="h-4 w-4" />
                                        Delete
                                    </DropdownMenu.Item>
                                </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                        </DropdownMenu.Root>
                    {:else}
                        <Button size="sm" variant="secondary" disabled={busy} onclick={() => onRedownload(media)}>
                            <RotateCcw class="h-4 w-4" />
                        </Button>
                    {/if}
                </div>
            </div>
        </div>
    </div>

    {#if showBar}
        <div class="px-4 pb-4">
            <div class="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                    class="h-full rounded-full transition-all {isFinalizing ? 'bg-green-500' : 'bg-blue-500'}"
                    style="width: {percent}%"
                ></div>
            </div>
            <div class="mt-1.5 flex gap-3 text-xs text-muted-foreground">
                {#if isFinalizing}
                    <span>Finalizing media: {percent}%</span>
                {:else}
                    <span>{percent}%</span>
                    {#if totalSize > 0}
                        <span class="tabular-nums">
                            {formatFileSize(Math.round(totalSize * (progress ?? 0)))} / {formatFileSize(totalSize)}
                        </span>
                    {/if}
                    <span>{formatFileSize(downloadSpeed)}/s</span>
                    <span>{peers} peers</span>
                {/if}
            </div>
        </div>
    {/if}

    {#if episodes.length > 0}
        <div class="px-4 pb-3">
            <button
                type="button"
                class="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-white"
                onclick={() => (episodesOpen = !episodesOpen)}
            >
                <ChevronRight class="h-3.5 w-3.5 transition-transform {episodesOpen ? 'rotate-90' : ''}" />
                {episodes.length}
                {episodes.length === 1 ? "episode" : "episodes"}
            </button>
            {#if episodesOpen}
                <ul class="mt-2 space-y-1.5">
                    {#each episodes as episode (episode.id)}
                        <li class="flex items-center gap-3 text-xs">
                            <span class="w-16 shrink-0 text-muted-foreground">{episodeLabel(episode)}</span>
                            <div class="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                                <div
                                    class="h-full rounded-full {episode.status === 'complete'
                                    ? 'bg-emerald-500'
                                    : 'bg-blue-500'}"
                                    style="width: {Math.round(episode.progress * 100)}%"
                                ></div>
                            </div>
                            <span class="w-9 shrink-0 text-right text-muted-foreground"
                                >{Math.round(episode.progress * 100)}%</span
                            >
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>
    {/if}
</div>
