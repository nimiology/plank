<script lang="ts">
    import "vidstack/player/styles/default/theme.css";
    import "vidstack/player/styles/default/layouts/video.css";
    import "vidstack/player";
    import "vidstack/player/layouts";
    import "vidstack/player/ui";
    import { ArrowLeft, Download, EllipsisVertical, Play, Users, X } from "@lucide/svelte";
    import { DropdownMenu, Progress } from "bits-ui";
    import { onDestroy, onMount } from "svelte";
    import { isHLSProvider } from "vidstack";
    import type { MediaPlayerElement } from "vidstack/elements";
    import { browser } from "$app/environment";
    import { connectMediaProgressStream } from "$lib/client/media-progress-stream";
    import PlayerSubtitleMenu from "$lib/components/PlayerSubtitleMenu.svelte";
    import { createSavePositionMutation } from "$lib/data/media";
    import type { ProgressInfo } from "$lib/types";
    import { isTerminalProgressStatus } from "$lib/utils";
    import type { PageData } from "./$types";

    let { data } = $props<{ data: PageData }>();
    let currentMediaId = $state("");
    let progressInfo: ProgressInfo | null = $state(null);
    let stopProgressStream: (() => void) | null = $state(null);
    let playerReady = $state(false);
    let playerErrorMessage = $state<string | null>(null);

    $effect(() => {
        if (currentMediaId === data.media.id) {
            return;
        }
        currentMediaId = data.media.id;
        progressInfo = data.progress ?? null;
        playerReady = false;
        playerErrorMessage = null;
        stopLiveProgressStream();
    });

    // Player state
    let playerEl: MediaPlayerElement | undefined = $state(undefined);
    let showOverlay = $state(true);

    // Menu state
    let showMenu = $state(false);
    let showStats = $state(false);

    // Play position state
    const initialPosition = $derived((data.media.playPosition ?? 0) > 0 ? data.media.playPosition : null);
    let positionRestored = $state(false);
    const savePositionMutation = createSavePositionMutation();
    let lastSaveTime = 0;
    const SAVE_INTERVAL_MS = 5000;
    const NEXT_EPISODE_WINDOW_SECONDS = 60;
    let nextEpisodeDismissed = $state(false);
    let playbackPosition = $state(0);
    let playbackDuration: number | null = $state(null);
    let playbackEnded = $state(false);
    let blockStalePositionSave = false;

    // Subtitle state
    let subtitleTracks = $derived(data.subtitleTracks);

    function formatSpeed(bytesPerSecond: number): string {
        if (bytesPerSecond < 1024) {
            return `${bytesPerSecond} B/s`;
        }
        if (bytesPerSecond < 1024 * 1024) {
            return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
        }
        return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
    }

    function getVideoSrc(): string | { src: string; type: string } {
        if (data.playback.mode === "hls") {
            return { src: data.playback.src, type: "application/x-mpegurl" };
        }
        return data.playback.src;
    }

    // Bundle hls.js instead of letting the player fetch it from a CDN.
    $effect(() => {
        const player = playerEl;
        if (!player) {
            return;
        }
        const onProviderChange = (event: Event) => {
            const provider = (event as CustomEvent).detail;
            if (provider && isHLSProvider(provider)) {
                provider.library = () => import("hls.js");
            }
        };
        player.addEventListener("provider-change", onProviderChange);
        return () => player.removeEventListener("provider-change", onProviderChange);
    });

    function openExternal(scheme: "vlc" | "infuse"): void {
        const url = data.playback.externalUrl;
        if (!url) {
            return;
        }
        window.location.href =
            scheme === "vlc" ? `vlc://${url}` : `infuse://x-callback-url/play?url=${encodeURIComponent(url)}`;
    }

    async function copyExternalLink(): Promise<void> {
        if (data.playback.externalUrl) {
            await navigator.clipboard.writeText(data.playback.externalUrl);
        }
    }

    function getIsReady(): boolean {
        return (
            progressInfo?.status === "complete" ||
            (progressInfo?.progress ?? 0) > 0.05 ||
            data.media.status === "complete"
        );
    }

    function getKnownDuration(): number | undefined {
        const duration = playerEl?.duration;
        if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
            return undefined;
        }
        return duration;
    }

    function syncPlaybackState() {
        playbackPosition = playerEl?.currentTime ?? 0;
        playbackDuration = getKnownDuration() ?? null;
    }

    function getNextEpisodeImage(): string | null {
        return data.nextEpisode?.stillPath ?? data.nextEpisode?.backdropUrl ?? data.nextEpisode?.posterUrl ?? null;
    }

    function formatEpisodeLabel(): string {
        if (!data.nextEpisode || data.nextEpisode.seasonNumber === null || data.nextEpisode.episodeNumber === null) {
            return "Next Episode";
        }

        return `S${String(data.nextEpisode.seasonNumber).padStart(2, "0")}E${String(data.nextEpisode.episodeNumber).padStart(2, "0")}`;
    }

    function isInNextEpisodeWindow(): boolean {
        const duration = playbackDuration ?? getKnownDuration();
        if (!duration) {
            return false;
        }

        return Math.max(duration - playbackPosition, 0) <= NEXT_EPISODE_WINDOW_SECONDS;
    }

    function shouldShowNextEpisodeCard(): boolean {
        return (
            data.media.type === "episode" &&
            Boolean(data.nextEpisode) &&
            !nextEpisodeDismissed &&
            (playbackEnded || isInNextEpisodeWindow())
        );
    }

    function dismissNextEpisodeCard() {
        nextEpisodeDismissed = true;
    }

    async function handlePlayNext() {
        const nextEpisode = data.nextEpisode;
        if (!nextEpisode) {
            return;
        }

        if (isInNextEpisodeWindow()) {
            const duration = playbackDuration ?? getKnownDuration();
            if (duration) {
                blockStalePositionSave = true;
                try {
                    await savePositionMutation.mutateAsync({
                        id: data.media.id,
                        position: duration,
                        duration,
                    });
                } catch (error) {
                    blockStalePositionSave = false;
                    console.error("Failed to save completion before playing next episode:", error);
                }
            }
        }

        window.location.assign(`/watch/${nextEpisode.id}`);
    }

    // Sync custom overlay with vidstack controls visibility
    function onControlsChange(event: Event) {
        const visible = (event as CustomEvent).detail;
        if (showMenu) {
            return;
        }
        showOverlay = visible;
    }

    function toggleStats() {
        showStats = !showStats;
        showMenu = false;
    }

    // Play position: save current time
    function savePosition(currentTime: number, duration?: number) {
        const id = data.media.id;
        if (!id || blockStalePositionSave || currentTime <= 0) {
            return;
        }

        savePositionMutation.mutate({
            id,
            position: currentTime,
            duration,
        });
    }

    function applyProgressUpdate(progress: ProgressInfo) {
        progressInfo = progress;
        if (!isTerminalProgressStatus(progress.status)) {
            playerErrorMessage = null;
        }
    }

    function getLoadingTitle(): string {
        if (playerErrorMessage) {
            return "Playback failed";
        }
        return `Loading ${data.media.title}...`;
    }

    function getLoadingMessage(): string {
        if (playerErrorMessage) {
            return playerErrorMessage;
        }
        if (progressInfo?.status === "downloading") {
            return "Media pixies are preparing your stream";
        }
        if (progressInfo?.status === "searching" || progressInfo?.status === "initializing") {
            return "Preparing your stream";
        }
        return "Waiting for video to stream in from space";
    }

    function startProgressStream() {
        if (stopProgressStream || isTerminalProgressStatus(progressInfo?.status ?? data.media.status)) {
            return;
        }
        stopProgressStream = connectMediaProgressStream(
            data.media.id,
            (progress) => {
                applyProgressUpdate(progress);
            },
            () => {
                stopProgressStream = null;
            }
        );
    }

    function stopLiveProgressStream() {
        if (!stopProgressStream) {
            return;
        }
        stopProgressStream();
        stopProgressStream = null;
    }

    // Player event handlers
    function onCanPlay() {
        syncPlaybackState();
        if (!positionRestored && initialPosition && initialPosition > 0 && playerEl) {
            playerEl.currentTime = initialPosition;
            playbackPosition = initialPosition;
            positionRestored = true;
        }
        playerReady = true;
        playerErrorMessage = null;
    }

    function onPlaying() {
        syncPlaybackState();
        playbackEnded = false;
        playerReady = true;
        playerErrorMessage = null;
    }

    function onPlayerError(event: Event) {
        console.error("Player failed to load media:", event);
        playerReady = false;
        if (isTerminalProgressStatus(progressInfo?.status ?? data.media.status)) {
            playerErrorMessage = "Playback failed to start. Please retry the download.";
            return;
        }
        playerErrorMessage = "Playback is still preparing. It should start soon.";
    }

    function onTimeUpdate() {
        syncPlaybackState();

        const now = Date.now();
        if (now - lastSaveTime < SAVE_INTERVAL_MS) {
            return;
        }
        lastSaveTime = now;

        const currentTime = playerEl?.currentTime ?? 0;
        const duration = getKnownDuration();
        if (currentTime > 0) {
            savePosition(currentTime, duration);
        }
    }

    function onEnded() {
        playbackEnded = true;
        syncPlaybackState();

        const duration = getKnownDuration();
        if (duration) {
            playbackPosition = duration;
            playbackDuration = duration;
            savePosition(duration, duration);
        }
    }

    // Lifecycle: attach player event listeners
    $effect(() => {
        if (!playerEl) {
            return;
        }

        const el = playerEl;
        el.addEventListener("can-play", onCanPlay);
        el.addEventListener("playing", onPlaying);
        el.addEventListener("error", onPlayerError);
        el.addEventListener("time-update", onTimeUpdate);
        el.addEventListener("ended", onEnded);
        el.addEventListener("controls-change", onControlsChange);

        return () => {
            el.removeEventListener("can-play", onCanPlay);
            el.removeEventListener("playing", onPlaying);
            el.removeEventListener("error", onPlayerError);
            el.removeEventListener("time-update", onTimeUpdate);
            el.removeEventListener("ended", onEnded);
            el.removeEventListener("controls-change", onControlsChange);
        };
    });

    onMount(() => {
        startProgressStream();
    });

    onDestroy(() => {
        stopLiveProgressStream();
        if (browser) {
            // Save final position via sendBeacon on page leave
            const id = data.media.id;
            if (!blockStalePositionSave && id && playerEl) {
                const currentTime = playerEl.currentTime;
                const duration = playerEl.duration;
                if (currentTime > 0) {
                    const payload = JSON.stringify({
                        position: currentTime,
                        duration,
                    });
                    navigator.sendBeacon(`/api/media/${id}/position`, payload);
                }
            }
        }
    });
</script>

<svelte:head>
    <title>{data.media.title} | Plank</title>
</svelte:head>

<div class="relative w-screen h-screen bg-black overflow-hidden group" role="presentation">
    <!-- Controls Overlay (Top) -->
    <div
        class="absolute top-0 left-0 w-full p-6 z-50 flex justify-between items-start transition-opacity duration-300 {showOverlay
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none'}"
    >
        <!-- Back Button -->
        <button
            onclick={() => window.history.back()}
            class="bg-black/50 hover:bg-black/70 text-white rounded-full p-3 backdrop-blur-sm transition-all hover:scale-105"
        >
            <ArrowLeft class="w-6 h-6" />
        </button>

        <DropdownMenu.Root bind:open={showMenu}>
            <DropdownMenu.Trigger
                class="rounded-full bg-black/50 p-3 text-white backdrop-blur-sm transition-all hover:scale-105 hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Player options"
            >
                <EllipsisVertical class="h-6 w-6" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    side="bottom"
                    align="end"
                    sideOffset={8}
                    class="z-60 w-48 overflow-hidden rounded-xl border border-white/10 bg-black/95 p-1.5 text-gray-200 shadow-2xl backdrop-blur-xl focus:outline-none"
                >
                    <DropdownMenu.Item
                        onSelect={toggleStats}
                        class="flex h-10 cursor-default select-none items-center justify-between rounded-lg px-3 text-sm outline-none data-highlighted:bg-white/10"
                    >
                        <span>Show Stats</span>
                        {#if showStats}
                            <span class="h-2 w-2 rounded-full bg-primary"></span>
                        {/if}
                    </DropdownMenu.Item>
                    {#if data.playback.externalUrl}
                        <DropdownMenu.Item
                            onSelect={() => openExternal("vlc")}
                            class="flex h-10 cursor-default select-none items-center rounded-lg px-3 text-sm outline-none data-highlighted:bg-white/10"
                        >
                            Play in VLC
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                            onSelect={() => openExternal("infuse")}
                            class="flex h-10 cursor-default select-none items-center rounded-lg px-3 text-sm outline-none data-highlighted:bg-white/10"
                        >
                            Play in Infuse
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                            onSelect={copyExternalLink}
                            class="flex h-10 cursor-default select-none items-center rounded-lg px-3 text-sm outline-none data-highlighted:bg-white/10"
                        >
                            Copy file link
                        </DropdownMenu.Item>
                    {/if}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    </div>

    <!-- Video Player -->
    <div class="w-full h-full">
        {#if getIsReady()}
            <media-player
                bind:this={playerEl}
                src={getVideoSrc()}
                autoplay
                playsinline
                keyTarget="document"
                streamType="on-demand"
                controlsDelay={3000}
                title={data.media.title}
                class="player dark"
            >
                <media-provider>
                    {#each subtitleTracks as track (track.id)}
                        <track
                            id={track.id}
                            src={track.src}
                            kind="subtitles"
                            label={track.label}
                            srclang={track.language}
                        >
                    {/each}
                </media-provider>
                {#if playerReady}
                    <media-video-layout></media-video-layout>
                    {#if playerEl}
                        {#key data.media.id}
                            <PlayerSubtitleMenu
                                player={playerEl}
                                mediaId={data.media.id}
                                mediaTitle={data.media.title}
                            />
                        {/key}
                    {/if}
                {/if}
            </media-player>
        {/if}
    </div>

    {#if !playerReady}
        <div class="absolute inset-0 z-30">
            {#if data.media.backdropUrl || data.media.posterUrl}
                <img
                    src={data.media.backdropUrl || data.media.posterUrl}
                    alt="Background"
                    class="absolute inset-0 w-full h-full object-cover blur-2xl opacity-30"
                >
            {/if}
            <div class="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-black/45 backdrop-blur-sm">
                <div class="relative">
                    <div class="absolute inset-0 animate-ping rounded-full bg-primary/20"></div>
                    <div
                        class="animate-spin rounded-full h-16 w-16 border-4 border-primary border-t-transparent relative z-10"
                    ></div>
                </div>
                <div class="text-center space-y-2 max-w-md px-6">
                    <h2 class="text-2xl font-bold text-white">{getLoadingTitle()}</h2>
                    <p class="text-zinc-300">{getLoadingMessage()}</p>
                    {#if progressInfo && progressInfo.status !== "complete"}
                        <p class="text-sm text-zinc-500">{(progressInfo.progress * 100).toFixed(1)}% downloaded</p>
                    {/if}
                </div>
            </div>
        </div>
    {/if}

    {#if shouldShowNextEpisodeCard() && data.nextEpisode}
        <div
            class="absolute right-4 bottom-24 z-40 w-[min(24rem,calc(100%-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-black/75 shadow-2xl backdrop-blur-xl md:right-6 md:bottom-28"
        >
            <div class="relative">
                <div class="relative aspect-video bg-zinc-900">
                    {#if getNextEpisodeImage()}
                        <img
                            src={getNextEpisodeImage() ?? undefined}
                            alt={data.nextEpisode.title}
                            class="w-full h-full object-cover"
                        >
                    {:else}
                        <div class="flex h-full items-center justify-center bg-zinc-900 text-sm text-zinc-400">
                            Next Episode
                        </div>
                    {/if}

                    <div class="absolute inset-0 bg-linear-to-t from-black via-black/60 to-transparent"></div>

                    <button
                        type="button"
                        class="absolute top-3 right-3 rounded-full bg-black/60 p-2 text-white transition hover:bg-black/80"
                        onclick={dismissNextEpisodeCard}
                        aria-label="Dismiss next episode card"
                    >
                        <X class="w-4 h-4" />
                    </button>

                    <div class="absolute inset-x-0 bottom-0 p-4">
                        <p class="text-[11px] font-semibold uppercase tracking-[0.24em] text-zinc-300">
                            {formatEpisodeLabel()}
                        </p>
                        <h2 class="mt-2 text-xl font-semibold text-white line-clamp-2">{data.nextEpisode.title}</h2>
                    </div>
                </div>

                <div class="space-y-3 p-4">
                    <button
                        type="button"
                        class="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-white transition hover:bg-primary/90"
                        onclick={handlePlayNext}
                    >
                        <Play class="w-4 h-4 fill-current" />
                        Play Next
                    </button>
                </div>
            </div>
        </div>
    {/if}

    <!-- Stats Overlay -->
    {#if showStats && progressInfo && progressInfo.status !== "complete"}
        <div
            class="absolute bottom-20 left-6 z-40 p-4 bg-black/60 backdrop-blur-md rounded-lg border border-white/10 text-xs font-mono space-y-2 transition-opacity duration-300 {showOverlay
                ? 'opacity-100'
                : 'opacity-0'}"
        >
            <div class="flex items-center gap-3 text-zinc-300">
                <Download class="w-4 h-4 text-blue-400" />
                <span>{formatSpeed(progressInfo.downloadSpeed)}</span>
            </div>
            <div class="flex items-center gap-3 text-zinc-300">
                <Users class="w-4 h-4 text-green-400" />
                <span>{progressInfo.peers} peers</span>
            </div>
            <Progress.Root
                value={progressInfo.progress * 100}
                max={100}
                aria-label="Download progress"
                class="w-48 h-1.5 bg-zinc-800 rounded-full overflow-hidden mt-2"
            >
                <div
                    class="h-full bg-primary transition-all duration-500 ease-out"
                    style="width: {progressInfo.progress * 100}%"
                ></div>
            </Progress.Root>
        </div>
    {/if}
</div>

<style>
    /* Player sizing — fullscreen-style, no border/radius */
    .player {
        display: block;
        width: 100%;
        height: 100%;

        --video-brand: hsl(0 84% 60%);
        --video-border: none;
        --video-border-radius: 0;
        --video-bg: black;
        --video-focus-ring-color: hsl(0 84% 60%);
        --video-controls-color: #f5f5f5;
        --media-font-family: "Outfit", ui-sans-serif, system-ui, sans-serif;

        /* Match overlay fade: 300ms transition, synced with back button */
        --media-controls-in-transition: opacity 0.3s ease-in;
        --media-controls-out-transition: opacity 0.3s ease-out;

        /* Slightly larger buttons for a cinematic feel */
        --media-button-border-radius: 9999px;
        --media-button-hover-bg: rgb(255 255 255 / 0.15);

        /* Slider/progress bar in brand red */
        --media-slider-track-fill-bg: hsl(0 84% 60%);
        --media-slider-track-bg: rgb(255 255 255 / 0.2);

        /* Tooltip styling to match glassmorphism */
        --media-tooltip-bg-color: rgb(0 0 0 / 0.85);
        --media-tooltip-border: 1px solid rgb(255 255 255 / 0.1);
        --media-tooltip-color: #f5f5f5;

        /* Menu styling */
        --media-menu-bg: rgb(10 10 10 / 0.95);
        --media-menu-border: 1px solid rgb(255 255 255 / 0.1);

        /* Buffering spinner in brand red */
        --media-buffering-track-fill-color: hsl(0 84% 60%);
    }
</style>
