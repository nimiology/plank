<script lang="ts">
    import { Compass, Film, LogOut, Plus, Search, Settings, Users } from "@lucide/svelte";
    import { Avatar, DropdownMenu, Tooltip } from "bits-ui";
    import type { Snippet } from "svelte";
    import { fade, fly } from "svelte/transition";
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import { uiState } from "$lib/ui-state.svelte";
    import { cn } from "$lib/utils";
    import AddMediaDialog from "./AddMediaDialog.svelte";
    import Facehash from "./facehash/Facehash.svelte";

    let {
        children,
        logout,
    }: {
        children: Snippet;
        logout: () => void;
    } = $props();

    const navItems = [
        { href: "/", icon: Film, label: "Library" },
        { href: "/browse", icon: Compass, label: "Browse" },
        { href: "/search", icon: Search, label: "Search" },
    ];

    // Hide nav on player, profile selection, and onboarding pages
    const hideNav = $derived(
        page.url.pathname.startsWith("/watch") ||
            page.url.pathname === "/profiles" ||
            page.url.pathname.startsWith("/profiles/") ||
            page.url.pathname.startsWith("/onboarding")
    );
</script>

<div
    class={cn(
        "min-h-screen bg-background text-foreground flex flex-col relative",
        !hideNav && "pb-24",
    )}
>
    <!-- Account Button - Bottom Right Corner -->
    {#if !hideNav}
        <div class="fixed right-2 bottom-8 z-50 sm:right-8" transition:fly={{ y: 20, duration: 300 }}>
            <DropdownMenu.Root>
                <div class="rounded-full border border-white/10 bg-black/80 p-1.5 shadow-2xl backdrop-blur-xl">
                    <DropdownMenu.Trigger
                        class="flex h-12 w-12 items-center justify-center rounded-full transition-all duration-300 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label="Account"
                    >
                        <Avatar.Root class="h-12.5 w-12.5 rounded-full">
                            <Avatar.Image
                                src={page.data.user?.image}
                                alt={page.data.user?.name || "User"}
                                class="h-12.5 w-12.5 rounded-full object-cover"
                            />
                            <Avatar.Fallback>
                                <Facehash
                                    class="flex items-center justify-center rounded-full"
                                    name={page.data.user?.name || ""}
                                    variant="solid"
                                    size={50}
                                    intensity3d="dramatic"
                                />
                            </Avatar.Fallback>
                        </Avatar.Root>
                    </DropdownMenu.Trigger>
                </div>

                <DropdownMenu.Portal>
                    <DropdownMenu.Content
                        side="top"
                        align="end"
                        sideOffset={16}
                        class="z-50 w-52 overflow-hidden rounded-xl border border-white/10 bg-black/95 p-1.5 text-gray-200 shadow-2xl backdrop-blur-xl focus:outline-none"
                    >
                        <DropdownMenu.Item
                            onSelect={() => {
                                void goto("/profiles");
                            }}
                            class="flex h-10 cursor-default select-none items-center gap-3 rounded-lg px-3 text-sm outline-none data-highlighted:bg-white/10"
                        >
                            <Users class="h-4 w-4" />
                            Switch Profile
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                            onSelect={() => {
                                void goto("/settings/account");
                            }}
                            class="flex h-10 cursor-default select-none items-center gap-3 rounded-lg px-3 text-sm outline-none data-highlighted:bg-white/10"
                        >
                            <Settings class="h-4 w-4" />
                            Settings
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator class="my-1 h-px bg-white/10" />
                        <DropdownMenu.Item
                            onSelect={logout}
                            class="flex h-10 cursor-default select-none items-center gap-3 rounded-lg px-3 text-sm text-red-400 outline-none data-highlighted:bg-red-500/10"
                        >
                            <LogOut class="h-4 w-4" />
                            Sign Out
                        </DropdownMenu.Item>
                    </DropdownMenu.Content>
                </DropdownMenu.Portal>
            </DropdownMenu.Root>
        </div>
    {/if}

    <!-- Main Content -->
    <main class="flex-1 relative">
        <div
            class="absolute inset-0 bg-linear from-background via-background/95 to-background pointer-events-none -z-10"
        ></div>
        {@render children()}
    </main>

    <!-- Bottom Floating Pill Navigation (Hidden on Player and Profiles) -->
    {#if !hideNav}
        <div class="fixed bottom-8 left-1/2 -translate-x-1/2 z-50" transition:fly={{ y: 20, duration: 300 }}>
            <Tooltip.Provider delayDuration={300}>
                <nav
                    class="flex items-center gap-1 p-1.5 rounded-full border border-white/10 bg-black/80 backdrop-blur-xl shadow-2xl"
                >
                    {#each navItems as item}
                        {@const isActive = page.url.pathname === item.href}
                        <Tooltip.Root>
                            <Tooltip.Trigger>
                                {#snippet child({ props })}
                                    <a
                                        {...props}
                                        href={item.href}
                                        class={cn(
                                            "flex items-center justify-center w-12 h-12 rounded-full transition-all duration-300 relative hover:bg-white/10",
                                            isActive
                                                ? "text-white bg-white/10"
                                                : "text-zinc-400 hover:text-white",
                                        )}
                                        aria-label={item.label}
                                    >
                                        <item.icon class="w-5 h-5 relative z-10" />
                                        {#if isActive}
                                            <div
                                                class="absolute bottom-2 w-1 h-1 bg-primary rounded-full"
                                                transition:fade
                                            ></div>
                                        {/if}
                                    </a>
                                {/snippet}
                            </Tooltip.Trigger>
                            <Tooltip.Portal>
                                <Tooltip.Content
                                    side="top"
                                    sideOffset={8}
                                    class="z-60 rounded-lg border border-white/10 bg-zinc-950 px-2.5 py-1.5 text-xs text-white shadow-xl"
                                >
                                    {item.label}
                                </Tooltip.Content>
                            </Tooltip.Portal>
                        </Tooltip.Root>
                    {/each}

                    <div class="w-px h-8 bg-white/10 mx-1"></div>

                    <Tooltip.Root>
                        <Tooltip.Trigger
                            onclick={() => uiState.toggleAddMediaDialog()}
                            class="flex items-center justify-center w-12 h-12 rounded-full transition-all duration-300 text-zinc-400 hover:text-white hover:bg-white/10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="Add Media"
                        >
                            <Plus class="w-6 h-6" />
                        </Tooltip.Trigger>
                        <Tooltip.Portal>
                            <Tooltip.Content
                                side="top"
                                sideOffset={8}
                                class="z-60 rounded-lg border border-white/10 bg-zinc-950 px-2.5 py-1.5 text-xs text-white shadow-xl"
                            >
                                Add Media
                            </Tooltip.Content>
                        </Tooltip.Portal>
                    </Tooltip.Root>
                </nav>
            </Tooltip.Provider>
        </div>

        <!-- Mounts with the nav: the + button above is its only trigger. -->
        <AddMediaDialog />
    {/if}
</div>
