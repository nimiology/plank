import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBrowse, fetchSeasons, resolveTorrent } from "$lib/data/browse";
import { searchOpenSubtitles } from "$lib/data/media";
import { fetchProwlarrStatus } from "$lib/data/prowlarr";
import { DEFAULT_CATALOG_FILTERS } from "$lib/data/search";

vi.mock("$app/navigation", () => ({ invalidate: vi.fn() }));

const fetchMock = vi.fn();
global.fetch = fetchMock;

function mockJsonResponse(body: unknown, ok = true) {
	return {
		ok,
		status: ok ? 200 : 500,
		statusText: ok ? "OK" : "Error",
		json: async () => body,
	};
}

describe("client data", () => {
	beforeEach(() => {
		fetchMock.mockReset();
	});

	it("omits a null episode number from subtitle searches", async () => {
		fetchMock.mockResolvedValue(mockJsonResponse([]));

		await searchOpenSubtitles("123", {
			languages: "en",
			seasonNumber: 1,
			episodeNumber: null,
		});

		const url = new URL(vi.mocked(fetchMock).mock.calls[0][0] as string, "http://localhost");
		expect(url.pathname).toBe("/api/media/123/subtitles/search");
		expect(url.searchParams.get("seasonNumber")).toBe("1");
		expect(url.searchParams.get("episodeNumber")).toBeNull();
	});

	it("fetches the selected browse page", async () => {
		fetchMock.mockResolvedValue(mockJsonResponse({ items: [], page: 2, totalPages: 2 }));

		await fetchBrowse({ ...DEFAULT_CATALOG_FILTERS, media: "movie" }, 2);

		const url = new URL(vi.mocked(fetchMock).mock.calls[0][0] as string, "http://localhost");
		expect(url.pathname).toBe("/api/browse");
		expect(url.searchParams.get("type")).toBeNull();
		expect(url.searchParams.get("media")).toBe("movie");
		expect(url.searchParams.get("page")).toBe("2");
	});

	it("resolves a torrent with JSON input", async () => {
		fetchMock.mockResolvedValue(mockJsonResponse({ success: true }));
		const item = { imdbId: "tt123", tmdbId: 456, title: "Example", year: 2020 };

		await resolveTorrent(item);

		const [url, init] = vi.mocked(fetchMock).mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/browse/resolve");
		expect(init.method).toBe("POST");
		expect(init.body).toBe(JSON.stringify(item));
		expect(new Headers(init.headers).get("content-type")).toBe("application/json");
	});

	it("fetches Prowlarr status", async () => {
		fetchMock.mockResolvedValue(
			mockJsonResponse({
				configured: true,
				needsSetup: false,
			})
		);

		await fetchProwlarrStatus();

		expect(fetchMock).toHaveBeenCalledWith("/api/prowlarr/status");
	});

	it("fetches seasons for a show", async () => {
		fetchMock.mockResolvedValue(mockJsonResponse({ seasons: [] }));

		await fetchSeasons(12_345);

		expect(fetchMock).toHaveBeenCalledWith("/api/browse/seasons/12345");
	});

	it.each([
		[
			"browse",
			() => fetchBrowse({ ...DEFAULT_CATALOG_FILTERS, media: "movie" }, 1),
			"Failed to fetch browse titles",
		],
		[
			"torrent resolution",
			() => resolveTorrent({ imdbId: "tt", tmdbId: 1, title: "Example", year: null }),
			"Failed to resolve torrent",
		],
		["Prowlarr status", fetchProwlarrStatus, "Failed to fetch Prowlarr status"],
		["seasons", () => fetchSeasons(123), "Failed to fetch seasons"],
	])("reports %s request failures", async (_name, request, message) => {
		fetchMock.mockResolvedValue(mockJsonResponse({}, false));

		await expect(request()).rejects.toThrow(message);
	});
});
