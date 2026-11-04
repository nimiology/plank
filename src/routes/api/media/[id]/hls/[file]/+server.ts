import { createReadStream, existsSync, statSync } from "node:fs";
import { error } from "@sveltejs/kit";
import { requireMediaAccess } from "$lib/server/api-guard";
import { buildPlaylist, getSegment } from "$lib/server/hls";
import type { RequestHandler } from "./$types";

const SEGMENT_NAME = /^(\d+)\.ts$/;

export const GET: RequestHandler = async ({ params, locals }) => {
	const { mediaItem } = requireMediaAccess(locals, params.id);
	const filePath = mediaItem.filePath;
	if (!(filePath && existsSync(filePath))) {
		throw error(404, "Media is not in the library yet");
	}

	if (params.file === "index.m3u8") {
		return new Response(await buildPlaylist(filePath), {
			headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-cache" },
		});
	}

	const match = SEGMENT_NAME.exec(params.file);
	if (!match) {
		throw error(404, "Not found");
	}

	let segmentPath: string | null;
	try {
		segmentPath = await getSegment(mediaItem.id, filePath, Number.parseInt(match[1], 10));
	} catch (errorValue) {
		console.error("[HLS] Segment failed:", errorValue);
		throw error(500, "Conversion failed");
	}
	if (!segmentPath) {
		throw error(503, "Segment is not ready");
	}

	return new Response(createReadStream(segmentPath) as unknown as ReadableStream, {
		headers: {
			"Content-Type": "video/mp2t",
			"Content-Length": statSync(segmentPath).size.toString(),
			"Cache-Control": "private, max-age=3600",
		},
	});
};
