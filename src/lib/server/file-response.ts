import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { error } from "@sveltejs/kit";

const RANGE_BYTES_REGEX = /bytes=/;

const MIME_TYPES: Record<string, string> = {
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".avi": "video/x-msvideo",
	".mov": "video/quicktime",
	".m4v": "video/x-m4v",
};

export function getVideoMimeType(fileName: string): string {
	return MIME_TYPES[path.extname(fileName).toLowerCase()] || "application/octet-stream";
}

export function silenceAbortErrors(stream: Readable): ReadableStream {
	stream.on("error", (errorValue: NodeJS.ErrnoException) => {
		if (
			errorValue.code === "ERR_STREAM_PREMATURE_CLOSE" ||
			errorValue.code === "ABORT_ERR" ||
			errorValue.name === "AbortError"
		) {
			return;
		}
		console.error("[Stream] Unexpected stream error:", errorValue);
	});
	return stream as unknown as ReadableStream;
}

/** Serve a file on disk, honouring a Range header so players can seek. */
export function serveFile(filePath: string, range: string | null, fileName = path.basename(filePath)): Response {
	const fileSize = statSync(filePath).size;
	const headers: Record<string, string> = {
		"Accept-Ranges": "bytes",
		"Content-Type": getVideoMimeType(fileName),
		"Content-Disposition": `inline; filename="${fileName.replaceAll('"', "")}"`,
		"Cache-Control": "private, max-age=3600",
	};
	if (!range) {
		headers["Content-Length"] = fileSize.toString();
		return new Response(silenceAbortErrors(createReadStream(filePath)), { status: 200, headers });
	}
	const parts = range.replace(RANGE_BYTES_REGEX, "").split("-");
	const start = Number.parseInt(parts[0], 10);
	const end = parts[1] ? Number.parseInt(parts[1], 10) : fileSize - 1;
	if (Number.isNaN(start) || start < 0 || start >= fileSize) {
		throw error(416, "Requested range not satisfiable");
	}
	const clampedEnd = Math.min(end, fileSize - 1);
	headers["Content-Range"] = `bytes ${start}-${clampedEnd}/${fileSize}`;
	headers["Content-Length"] = (clampedEnd - start + 1).toString();
	return new Response(silenceAbortErrors(createReadStream(filePath, { start, end: clampedEnd })), {
		status: 206,
		headers,
	});
}
