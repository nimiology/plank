<script lang="ts">
    import { CircleAlert, CircleCheck, Loader, RefreshCw } from "@lucide/svelte";
    import type { SubmitFunction } from "@sveltejs/kit";
    import { untrack } from "svelte";
    import { toast } from "svelte-sonner";
    import { enhance } from "$app/forms";
    import Button from "$lib/components/ui/Button.svelte";
    import Input from "$lib/components/ui/Input.svelte";
    import SelectField from "$lib/components/ui/SelectField.svelte";
    import Section from "../Section.svelte";
    import type { PageData } from "./$types";

    let { data } = $props<{ data: PageData }>();

    let encoder = $state(untrack(() => data.encoder));
    let engine = $state(untrack(() => data.engine));
    let rqbitUrl = $state(untrack(() => data.rqbitUrl));
    let busy = $state<"save" | "detect" | "test" | null>(null);

    const encoderItems = $derived(
        data.encoders.map((item: { value: string; label: string; working: boolean }) => ({
            value: item.value,
            label: item.working ? item.label : `${item.label} (not working here)`,
            disabled: !item.working,
        }))
    );
    const engineItems = [
        { value: "webtorrent", label: "WebTorrent (built in)" },
        { value: "rqbit", label: "rqbit (separate service)" },
    ];
    const dirty = $derived(encoder !== data.encoder || engine !== data.engine || rqbitUrl !== data.rqbitUrl);

    function submit(kind: "save" | "detect" | "test", success: string): SubmitFunction {
        return () => {
            busy = kind;
            return async ({ result, update }) => {
                busy = null;
                if (result.type === "success") {
                    toast.success(success);
                } else {
                    const message =
                        result.type === "failure" && typeof result.data?.error === "string"
                            ? result.data.error
                            : "Something went wrong";
                    toast.error(message);
                }
                await update({ reset: false });
            };
        };
    }
</script>

<div class="divide-y divide-white/10">
    <Section
        title="Video encoder"
        description="Hardware Plank uses when a video has to be converted for the browser. Auto tests each encoder and picks the fastest one that works."
    >
        {#snippet action()}
            <form method="POST" action="?/detect" use:enhance={submit("detect", "Hardware detected again")}>
                <Button type="submit" variant="ghost" size="sm" disabled={busy === "detect"}>
                    {#if busy === "detect"}
                        <Loader class="mr-2 size-4 animate-spin" />
                    {:else}
                        <RefreshCw class="mr-2 size-4" />
                    {/if}
                    Detect again
                </Button>
            </form>
        {/snippet}

        <div class="max-w-md space-y-5">
            <div>
                <span class="mb-2 block text-sm font-medium">Encoder</span>
                <SelectField bind:value={encoder} items={encoderItems} ariaLabel="Video encoder" class="w-full" />
                <p class="mt-2 text-xs text-muted-foreground">
                    Auto picks <span class="text-foreground">{data.report.best}</span> on this machine.
                </p>
            </div>
            <ul class="space-y-1.5 text-sm">
                {#each data.encoders.filter((item: { value: string }) => item.value !== "auto") as item (item.value)}
                    <li class="flex items-center gap-2">
                        {#if item.working}
                            <CircleCheck class="size-4 text-green-500" />
                        {:else}
                            <CircleAlert class="size-4 text-muted-foreground" />
                        {/if}
                        <span class={item.working ? "text-foreground" : "text-muted-foreground"}>{item.label}</span>
                    </li>
                {/each}
            </ul>
            <p class="text-xs text-muted-foreground">
                ffmpeg: <code>{data.report.ffmpegPath}</code>
            </p>
        </div>
    </Section>

    <Section
        title="Download engine"
        description="The torrent engine behind downloads. rqbit is lighter and faster, but runs as its own service on this machine."
    >
        <div class="max-w-md space-y-5">
            <div>
                <span class="mb-2 block text-sm font-medium">Engine</span>
                <SelectField bind:value={engine} items={engineItems} ariaLabel="Download engine" class="w-full" />
            </div>
            {#if engine === "rqbit"}
                <form
                    method="POST"
                    action="?/testRqbit"
                    class="space-y-3"
                    use:enhance={submit("test", "rqbit is reachable")}
                >
                    <label for="rqbitUrl" class="block text-sm font-medium">rqbit API URL</label>
                    <Input
                        id="rqbitUrl"
                        name="rqbitUrl"
                        type="url"
                        bind:value={rqbitUrl}
                        placeholder="http://127.0.0.1:3030"
                    />
                    <p class="text-xs text-muted-foreground">
                        rqbit must save files on the same disk Plank reads. Start it with
                        <code>rqbit server start &lt;download dir&gt;</code>.
                    </p>
                    <Button type="submit" variant="ghost" size="sm" disabled={busy === "test"}>Test connection</Button>
                </form>
            {/if}
        </div>
    </Section>

    <form method="POST" action="?/save" class="flex justify-end py-6" use:enhance={submit("save", "Settings saved")}>
        <input type="hidden" name="encoder" value={encoder}>
        <input type="hidden" name="engine" value={engine}>
        <input type="hidden" name="rqbitUrl" value={rqbitUrl}>
        <Button type="submit" size="sm" disabled={!dirty || busy === "save"}>
            {#if busy === "save"}
                <Loader class="mr-2 size-4 animate-spin" />
            {/if}
            Save
        </Button>
    </form>
</div>
