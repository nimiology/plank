import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RqbitClient } from "../lib/server/torrent/rqbit";

const HASH = "0123456789abcdef0123456789abcdef01234567";
const FILE = Buffer.from("0123456789".repeat(10));
const calls: { method: string; url: string; body: string }[] = [];
let finished = false;
let refuseFileSelection = false;
let server: Server;
let baseUrl: string;

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
	});
}

// Shapes follow rqbit's http_api handlers (crates/librqbit/src/http_api).
beforeAll(async () => {
	server = createServer(async (request, response) => {
		const body = await readBody(request);
		const url = request.url ?? "";
		calls.push({ method: request.method ?? "", url, body });
		const json = (value: unknown) => {
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify(value));
		};
		if (request.method === "POST" && url.startsWith("/torrents?")) {
			json({
				id: 1,
				details: {
					info_hash: HASH,
					name: "Movie",
					output_folder: "/downloads/movie",
					files: [
						{ name: "Movie/movie.mkv", components: ["Movie", "movie.mkv"], length: 100, included: true },
						{ name: "Movie/movie.srt", components: ["Movie", "movie.srt"], length: 10, included: true },
					],
				},
				output_folder: "/downloads/movie",
			});
		} else if (url === `/torrents/${HASH}/stats/v1`) {
			json({
				state: "live",
				file_progress: finished ? [100, 10] : [50, 0],
				error: null,
				progress_bytes: finished ? 110 : 50,
				total_bytes: 110,
				finished,
				live: { download_speed: { mbps: 2 }, snapshot: { peer_stats: { live: 7 } } },
			});
		} else if (url.endsWith("/update_only_files") && refuseFileSelection) {
			// rqbit's answer while it re-checks data already on disk.
			refuseFileSelection = false;
			response.statusCode = 500;
			json({ error_kind: "internal_error", human_readable: "can't update initializing torrent" });
		} else if (url === `/torrents/${HASH}/stream/0`) {
			const [start, end] = (request.headers.range ?? "bytes=0-").replace("bytes=", "").split("-");
			const from = Number(start);
			const to = end ? Number(end) : FILE.length - 1;
			response.statusCode = 206;
			response.end(FILE.subarray(from, to + 1));
		} else {
			json({});
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	server.close();
});

describe("rqbit engine", () => {
	it("adds a magnet, reports progress, streams a range, and finishes", async () => {
		const client = new RqbitClient(baseUrl);
		const torrent = client.add(`magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=Movie`, { path: "/downloads/movie" });

		await new Promise<void>((resolve) => torrent.on("ready", resolve));
		expect(calls[0]).toMatchObject({ method: "POST", body: expect.stringContaining("magnet:") });
		expect(calls[0].url).toContain("output_folder=%2Fdownloads%2Fmovie");
		expect(torrent.files.map((file) => [file.name, file.path, file.length])).toEqual([
			["movie.mkv", "Movie/movie.mkv", 100],
			["movie.srt", "Movie/movie.srt", 10],
		]);
		expect(client.get(HASH)).toBe(torrent);

		torrent.files[1].deselect();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(calls.find((call) => call.url.endsWith("/update_only_files"))?.body).toBe('{"only_files":[0]}');

		const chunks: Buffer[] = [];
		for await (const chunk of torrent.files[0].createReadStream({ start: 10, end: 19 })) {
			chunks.push(chunk as Buffer);
		}
		expect(Buffer.concat(chunks).toString()).toBe("0123456789");

		await new Promise<void>((resolve) => torrent.on("download", () => resolve()));
		expect(torrent.files[0].progress).toBe(0.5);
		expect(torrent.numPeers).toBe(7);
		expect(torrent.downloadSpeed).toBe(2 * 1024 * 1024);

		finished = true;
		await new Promise<void>((resolve) => torrent.on("done", resolve));
		expect(torrent.files[0].progress).toBe(1);

		await new Promise<void>((resolve) => torrent.destroy({ destroyStore: true }, resolve));
		expect(calls.at(-1)?.url).toBe(`/torrents/${HASH}/delete`);
	}, 15_000);

	it("retries file selection while rqbit is still checking existing data", async () => {
		const client = new RqbitClient(baseUrl);
		const torrent = client.add(`magnet:?xt=urn:btih:${HASH}`, { path: "/downloads/movie" });
		await new Promise<void>((resolve) => torrent.on("ready", resolve));
		refuseFileSelection = true;
		const before = calls.length;

		torrent.files[1].deselect();
		await new Promise((resolve) => setTimeout(resolve, 5500));

		const attempts = calls.slice(before).filter((call) => call.url.endsWith("/update_only_files"));
		expect(attempts).toHaveLength(2);
		expect(attempts[1].body).toBe('{"only_files":[0]}');
		client.destroy();
	}, 15_000);

	it("rejects links without an info hash", () => {
		expect(() => new RqbitClient(baseUrl).add("https://example.test/file.torrent")).toThrow("info hash");
	});
});
