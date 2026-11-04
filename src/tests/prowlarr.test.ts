import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	filterByQuality,
	filterByReleaseGroup,
	findBestTorrent,
	type IndexerResult,
	parseProwlarrResults,
	searchProwlarr,
	searchSourceCandidates,
	selectBestTorrent,
} from "$lib/server/prowlarr";
import { updateSettings } from "$lib/server/settings";

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("Prowlarr Client", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		global.fetch = mockFetch;
		await updateSettings({ prowlarrUrl: "", prowlarrApiKey: "" });
	});

	describe("settings integration", () => {
		it("uses Prowlarr settings from env when DB settings are empty", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => [],
			});

			await searchProwlarr("tt1234567");

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("http://localhost:9696/api/v1/search");
			expect(url).toContain("apikey=test-api-key");
		});

		it("uses Prowlarr settings from DB over env", async () => {
			await updateSettings({ prowlarrUrl: "http://db-prowlarr:9696", prowlarrApiKey: "db-prowlarr-api-key" });
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => [],
			});

			await searchProwlarr("tt1234567");

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("http://db-prowlarr:9696/api/v1/search");
			expect(url).toContain("apikey=db-prowlarr-api-key");
			expect(url).not.toContain("test-api-key");
		});
	});

	describe("parseProwlarrResults", () => {
		it("should parse Prowlarr JSON response", () => {
			const mockResponse = [
				{
					title: "Movie.2024.1080p.BluRay.x264-YTS",
					magnetUrl: "magnet:?xt=urn:btih:abc123",
					infoHash: "abc123",
					size: 2_147_483_648,
					seeders: 150,
					indexer: "YTS",
				},
				{
					title: "Movie.2024.720p.WEB-DL-RARBG",
					downloadUrl: "magnet:?xt=urn:btih:def456",
					infoHash: "def456",
					size: 1_073_741_824,
					seeders: 75,
					indexer: "RARBG",
				},
			];

			const results = parseProwlarrResults(mockResponse);

			expect(results).toHaveLength(2);
			expect(results[0].title).toBe("Movie.2024.1080p.BluRay.x264-YTS");
			expect(results[0].magnetUri).toBe("magnet:?xt=urn:btih:abc123");
			expect(results[0].infohash).toBe("abc123");
			expect(results[0].size).toBe(2_147_483_648);
			expect(results[0].seeders).toBe(150);
			expect(results[0].indexer).toBe("YTS");
		});

		it("should handle empty results", () => {
			const results = parseProwlarrResults([]);
			expect(results).toHaveLength(0);
		});

		it("should filter out results without magnet links or infohash", () => {
			const mockResponse = [
				{
					title: "Movie.2024.1080p.BluRay",
					magnetUrl: "magnet:?xt=urn:btih:abc123",
					infoHash: "abc123",
					size: 2_147_483_648,
					seeders: 100,
				},
				{
					title: "Movie.2024.720p.WEB-DL",
					// No magnet
					size: 1_073_741_824,
					seeders: 50,
				},
			];

			const results = parseProwlarrResults(mockResponse as any);
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Movie.2024.1080p.BluRay");
		});
	});

	describe("filterByReleaseGroup", () => {
		const createResult = (title: string, seeders = 100): IndexerResult => ({
			title,
			magnetUri: "magnet:?xt=urn:btih:hash",
			infohash: "hash",
			size: 2_147_483_648,
			seeders,
			indexer: "Test",
		});

		it("should filter for trusted release groups", () => {
			const results: IndexerResult[] = [
				createResult("Movie.2024.1080p.BluRay.x264-YTS"),
				createResult("Movie.2024.1080p.BluRay.x264-RARBG"),
				createResult("Movie.2024.1080p.BluRay.x264-BONE"),
				createResult("Movie.2024.1080p.WEB-DL-YIFY"),
			];

			const trustedGroups = ["YTS", "YIFY", "BONE"];
			const filtered = filterByReleaseGroup(results, trustedGroups);

			expect(filtered).toHaveLength(3);
			expect(filtered.map((r) => r.title)).toEqual([
				"Movie.2024.1080p.BluRay.x264-YTS",
				"Movie.2024.1080p.BluRay.x264-BONE",
				"Movie.2024.1080p.WEB-DL-YIFY",
			]);
		});

		it("should return all results if no trusted groups specified", () => {
			const results: IndexerResult[] = [
				createResult("Movie.2024.1080p.BluRay.x264-YTS"),
				createResult("Movie.2024.1080p.BluRay.x264-RARBG"),
			];

			const filtered = filterByReleaseGroup(results, []);
			expect(filtered).toHaveLength(2);
		});
	});

	describe("filterByQuality", () => {
		const createResult = (title: string, seeders = 100): IndexerResult => ({
			title,
			magnetUri: "magnet:?xt=urn:btih:hash",
			infohash: "hash",
			size: 2_147_483_648,
			seeders,
			indexer: "Test",
		});

		it("should filter out low quality releases (CAM, TS, etc)", () => {
			const results: IndexerResult[] = [
				createResult("Movie.2024.1080p.BluRay.x264-YTS"),
				createResult("Movie.2024.CAM.x264-LOL"),
				createResult("Movie.2024.TS.x264-LOL"),
				createResult("Movie.2024.HDCAM.x264-LOL"),
				createResult("Movie.2024.720p.WEB-DL-YIFY"),
			];

			const filtered = filterByQuality(results);

			expect(filtered).toHaveLength(2);
			expect(filtered.map((r) => r.title)).toEqual([
				"Movie.2024.1080p.BluRay.x264-YTS",
				"Movie.2024.720p.WEB-DL-YIFY",
			]);
		});

		it("should keep high quality releases", () => {
			const results: IndexerResult[] = [
				createResult("Movie.2024.2160p.UHD.BluRay.x265-YTS"),
				createResult("Movie.2024.1080p.BluRay.x264-BONE"),
				createResult("Movie.2024.720p.BluRay.x264-YIFY"),
			];

			const filtered = filterByQuality(results);
			expect(filtered).toHaveLength(3);
		});
	});

	describe("selectBestTorrent", () => {
		const createResult = (title: string, seeders: number, size: number): IndexerResult => ({
			title,
			magnetUri: `magnet:?xt=urn:btih:${title}`,
			infohash: title,
			size,
			seeders,
			indexer: "Test",
		});

		it("should select torrent with most seeders", () => {
			const results: IndexerResult[] = [
				createResult("Movie.1080p-A", 50, 2_147_483_648),
				createResult("Movie.1080p-B", 200, 2_147_483_648),
				createResult("Movie.1080p-C", 100, 2_147_483_648),
			];

			const best = selectBestTorrent(results);
			expect(best?.title).toBe("Movie.1080p-B");
		});

		it("should return null for empty results", () => {
			const best = selectBestTorrent([]);
			expect(best).toBeNull();
		});

		it("should prefer higher quality when seeders are equal", () => {
			const results: IndexerResult[] = [
				createResult("Movie.2024.720p.BluRay-A", 50, 1_073_741_824),
				createResult("Movie.2024.1080p.BluRay-B", 50, 2_147_483_648),
			];

			// With equal seeders, 1080p should win due to quality score (80 vs 60)
			const best = selectBestTorrent(results);
			expect(best?.title).toBe("Movie.2024.1080p.BluRay-B");
		});

		it("should prefer 1337x, then YTS, then The Pirate Bay when quality and seeders match", () => {
			const results: IndexerResult[] = [
				{ ...createResult("Movie.2024.1080p.BluRay-TPB", 50, 2_147_483_648), indexer: "The Pirate Bay" },
				{ ...createResult("Movie.2024.1080p.BluRay-YTS", 50, 2_147_483_648), indexer: "YTS" },
				{ ...createResult("Movie.2024.1080p.BluRay-1337x", 50, 2_147_483_648), indexer: "1337x" },
			];

			const best = selectBestTorrent(results);
			expect(best?.indexer).toBe("1337x");
		});
	});

	describe("searchProwlarr", () => {
		it("should search Prowlarr", async () => {
			const mockResponse = [
				{
					title: "Movie.2024.1080p.BluRay.x264-YTS",
					magnetUrl: "magnet:?xt=urn:btih:abc123",
					infoHash: "abc123",
					size: 2_147_483_648,
					seeders: 150,
				},
			];

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => mockResponse,
			});

			const results = await searchProwlarr("tt1234567");

			expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("/api/v1/search"), expect.any(Object));
			expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("query=tt1234567"), expect.any(Object));
			expect(results).toHaveLength(1);
		});

		it("drops results tagged with an adult (XXX) category", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => [
					{
						title: "Movie.2024.1080p.WEB-DL",
						magnetUrl: "magnet:?xt=urn:btih:aaa111",
						infoHash: "aaa111",
						size: 2_000_000_000,
						seeders: 40,
						categories: [{ id: 2040, name: "Movies/HD" }],
					},
					{
						title: "Movie.2024.XXX.1080p",
						magnetUrl: "magnet:?xt=urn:btih:bbb222",
						infoHash: "bbb222",
						size: 2_000_000_000,
						seeders: 90,
						categories: [{ id: 6000, name: "XXX" }],
					},
				],
			});

			const results = await searchProwlarr("Movie 2024");

			expect(results.map((result) => result.infohash)).toEqual(["aaa111"]);
		});

		it("should handle API errors gracefully", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 500,
			});

			const results = await searchProwlarr("tt1234567");
			expect(results).toEqual([]);
		});
	});

	describe("searchSourceCandidates", () => {
		const rawResults = [
			{
				title: "Movie.2024.720p.WEBRip-GROUP",
				downloadUrl: "http://localhost:9696/1/download?apikey=secret&link=abc",
				infoHash: "aaa",
				size: 1_000_000_000,
				seeders: 10,
			},
			{
				title: "Movie.2024.1080p.BluRay-GROUP",
				magnetUrl: "magnet:?xt=urn:btih:bbb",
				infoHash: "bbb",
				size: 2_000_000_000,
				seeders: 200,
			},
			{
				title: "Movie.2024.CAM.XviD",
				magnetUrl: "magnet:?xt=urn:btih:ccc",
				infoHash: "ccc",
				size: 700_000_000,
				seeders: 900,
			},
			{
				title: "Movie.2024.1080p.BluRay-GROUP",
				magnetUrl: "magnet:?xt=urn:btih:bbb",
				infoHash: "BBB",
				size: 2_000_000_000,
				seeders: 200,
			},
		];

		it("keeps every acceptable release, best first, without duplicates", async () => {
			mockFetch.mockResolvedValueOnce({ ok: true, json: async () => rawResults });

			const results = await searchSourceCandidates("Movie 2024", false);

			expect(results.map((result) => result.infohash)).toEqual(["bbb", "aaa"]);
		});

		it("searches the TV category for an episode", async () => {
			mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

			await searchSourceCandidates("Show S01E02", true);

			const url = mockFetch.mock.calls[0][0] as string;
			expect(url).toContain("categories=5000");
		});

		it("strips the Prowlarr API key from download links", async () => {
			mockFetch.mockResolvedValueOnce({ ok: true, json: async () => rawResults });

			const results = await searchSourceCandidates("Movie 2024", false);

			const downloadLink = results.find((result) => result.infohash === "aaa");
			expect(downloadLink?.magnetUri).toBe("http://localhost:9696/1/download?link=abc");
		});
	});

	describe("Season Search", () => {
		const createSeasonResult = (title: string, seeders = 50, size = 5_000_000_000): IndexerResult => ({
			title,
			magnetUri: `magnet:?xt=urn:btih:${title}`,
			infohash: title,
			size,
			seeders,
			indexer: "Test",
		});

		describe("searchSeasonTorrent", () => {
			it("should search with multiple queries", async () => {
				mockFetch.mockResolvedValue({
					ok: true,
					json: async () => [],
				});

				await import("$lib/server/prowlarr").then((m) => m.searchSeasonTorrent("Show Title", 1, "tt1234567"));

				// Should try IMDB search first
				expect(mockFetch).toHaveBeenCalledWith(
					expect.stringContaining("query=imdb%3Att1234567+S01"),
					expect.any(Object)
				);
				// Then title searches
				expect(mockFetch).toHaveBeenCalledWith(
					expect.stringContaining("query=Show+Title+S01"),
					expect.any(Object)
				);
			});
		});

		describe("findBestSeasonTorrent", () => {
			it("should return null when no results found", async () => {
				mockFetch.mockResolvedValue({
					ok: true,
					json: async () => [],
				});

				const { findBestSeasonTorrent } = await import("$lib/server/prowlarr");
				const result = await findBestSeasonTorrent("Show", 1);
				expect(result).toBeNull();
			});
		});
	});

	describe("Episode Fallback Search", () => {
		const createEpisodeResult = (title: string, seeders = 50): IndexerResult => ({
			title,
			magnetUri: `magnet:?xt=urn:btih:${seeders}`,
			infohash: `${title}-${seeders}`.toLowerCase(),
			size: 2_000_000_000,
			seeders,
			indexer: "Test",
		});

		it("falls back from imdb to show season episode queries", async () => {
			mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
			mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => [
					{
						title: "Show Title S01E02 1080p WEB-DL-TEST",
						magnetUrl: "magnet:?xt=urn:btih:abc123",
						infoHash: "abc123",
						size: 2_147_483_648,
						seeders: 25,
					},
				],
			});

			const result = await findBestTorrent("tt1234567", {
				mediaType: "episode",
				showTitle: "Show Title",
				seasonNumber: 1,
				episodeNumber: 2,
				episodeTitle: "Episode Name",
			});

			expect(result?.title).toBe("Show Title S01E02 1080p WEB-DL-TEST");
			expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining("query=tt1234567"), expect.any(Object));
			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("query=Show+Title+S01E02"),
				expect.any(Object)
			);
		});

		it("filters season packs out of fallback episode matches", async () => {
			mockFetch.mockResolvedValue({
				ok: true,
				json: async () => [
					{
						title: "Show Title Season 1 Complete 1080p",
						magnetUrl: "magnet:?xt=urn:btih:seasonpack",
						infoHash: "seasonpack",
						size: 9_000_000_000,
						seeders: 100,
					},
				],
			});

			const result = await findBestTorrent("tt1234567", {
				mediaType: "episode",
				showTitle: "Show Title",
				seasonNumber: 1,
				episodeNumber: 2,
			});

			expect(result).toBeNull();
		});
	});
});
