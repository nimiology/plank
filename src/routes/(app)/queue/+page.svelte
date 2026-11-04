<script lang="ts">
    import { ArrowLeft, CircleCheck } from "@lucide/svelte";
    import { invalidate } from "$app/navigation";
    import MediaRow from "$lib/components/MediaRow.svelte";
    import QueueGroup from "$lib/components/QueueGroup.svelte";
    import RedownloadDialog from "$lib/components/RedownloadDialog.svelte";
    import type { QueueEntry } from "$lib/types";
    import type { PageData } from "./$types";

    const ERROR_STATUSES = ["error", "not_found"];
    /** Running work first, then work that is still looking for a source. */
    const IN_PROGRESS_ORDER = ["finalizing", "downloading", "searching", "pending"];

    let { data } = $props<{ data: PageData }>();

    const entries = $derived(data.entries as QueueEntry[]);

    /** Unknown statuses sort last, so a new status never hides a row. */
    function progressRank(entry: QueueEntry): number {
        const index = IN_PROGRESS_ORDER.indexOf(entry.status);
        return index === -1 ? IN_PROGRESS_ORDER.length : index;
    }

    const failed = $derived(entries.filter((entry: QueueEntry) => ERROR_STATUSES.includes(entry.status)));
    const running = $derived(
        entries
            .filter((entry: QueueEntry) => !ERROR_STATUSES.includes(entry.status))
            .sort((a: QueueEntry, b: QueueEntry) => progressRank(a) - progressRank(b))
    );

    /** The server load holds the live stats, so one poll refreshes the whole page. */
    $effect(() => {
        const interval = window.setInterval(() => invalidate("/api/media"), 1000);
        return () => window.clearInterval(interval);
    });

    let redownloadOpen = $state(false);
    let selected = $state<QueueEntry | null>(null);

    function entryLabel(entry: QueueEntry): string {
        const { media, showTitle } = entry;
        if (media.type === "episode") {
            const season = String(media.seasonNumber ?? 0).padStart(2, "0");
            const number = String(media.episodeNumber ?? 0).padStart(2, "0");
            return `${showTitle ?? "Unknown show"} • S${season}E${number}`;
        }
        if (media.type === "show") {
            return entry.sourceTitle ? `Show • ${entry.sourceTitle}` : "Show";
        }
        return media.year ? `Movie • ${media.year}` : "Movie";
    }

    function openRedownload(entry: QueueEntry) {
        selected = entry;
        redownloadOpen = true;
    }
</script>

<svelte:head>
    <title>Queue | Plank</title>
</svelte:head>

{#snippet row(entry: QueueEntry)}
    <MediaRow
        media={entry.media}
        label={entryLabel(entry)}
        status={entry.status}
        progress={entry.progress}
        downloadSpeed={entry.downloadSpeed}
        peers={entry.peers}
        totalSize={entry.totalSize}
        transcodeProgress={entry.transcodeProgress}
        episodes={entry.episodes}
        onRedownload={() => openRedownload(entry)}
    />
{/snippet}

<div class="mx-auto min-h-screen max-w-5xl px-4 pt-8 pb-28 sm:pt-12">
    <header class="mb-9">
        <a
            href="/"
            class="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-white"
        >
            <ArrowLeft class="h-4 w-4" />
            Library
        </a>
        <h1 class="mt-3 text-3xl font-semibold tracking-tight text-white sm:text-4xl">Queue</h1>
    </header>

    {#if entries.length === 0}
        <div class="flex flex-col items-center justify-center px-6 py-16 text-center">
            <div class="rounded-full bg-white/5 p-5">
                <CircleCheck class="h-9 w-9 text-emerald-500" />
            </div>
            <h2 class="mt-4 text-lg font-semibold text-white">Nothing in the queue</h2>
            <p class="mt-1 max-w-sm text-sm text-muted-foreground">Every title in your library downloaded fine.</p>
        </div>
    {/if}

    <QueueGroup title="Needs attention" count={failed.length}>
        {#each failed as entry (entry.id)}{@render row(entry)}{/each}
    </QueueGroup>

    <QueueGroup title="In progress" count={running.length}>
        {#each running as entry (entry.id)}{@render row(entry)}{/each}
    </QueueGroup>
</div>

<RedownloadDialog
    bind:open={redownloadOpen}
    media={selected?.media ?? null}
    downloadId={selected?.downloadId ?? null}
/>
