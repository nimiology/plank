import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getIncompleteDownloads: vi.fn(),
	updateProgress: vi.fn(),
	startDownload: vi.fn(() => Promise.resolve()),
	finalizeMediaToLibrary: vi.fn(),
	existsSync: vi.fn((_path: string) => true),
}));

vi.mock("node:fs", () => ({ existsSync: mocks.existsSync }));
vi.mock("node:fs/promises", () => ({
	default: {
		readdir: vi.fn(async () => [{ name: "episode.mkv", isDirectory: () => false, isFile: () => true }]),
		stat: vi.fn(async () => ({ size: 500 * 1024 * 1024 })),
		rm: vi.fn(),
	},
}));
vi.mock("../lib/server/db", () => ({
	mediaDb: {
		getIncompleteDownloads: mocks.getIncompleteDownloads,
		updateProgress: mocks.updateProgress,
		getById: vi.fn(() => ({ id: "m1", type: "movie", title: "Movie", year: 2020 })),
		updateFilePath: vi.fn(),
	},
}));
vi.mock("../lib/server/transcoder", () => ({ finalizeMediaToLibrary: mocks.finalizeMediaToLibrary }));
vi.mock("../lib/server/torrent/download", () => ({ startDownload: mocks.startDownload }));
vi.mock("../lib/server/torrent/status", () => ({ isDownloadActive: vi.fn(() => false) }));

import { recoverDownloads } from "../lib/server/torrent/recovery";

describe("download recovery after a restart", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.finalizeMediaToLibrary.mockResolvedValue({ filePath: "/library/movie.mkv", fileSize: 1 });
	});

	it("resumes a torrent instead of filing its possibly half-downloaded temp file", async () => {
		mocks.existsSync.mockImplementation((value: string) => !value.startsWith("/library"));
		mocks.getIncompleteDownloads.mockReturnValue([
			{ id: "m1", filePath: null, magnetLink: "magnet:?xt=urn:btih:abc" },
		]);

		await recoverDownloads();

		expect(mocks.startDownload).toHaveBeenCalledWith("m1", "magnet:?xt=urn:btih:abc");
		expect(mocks.finalizeMediaToLibrary).not.toHaveBeenCalled();
	});

	it("still files a temp video when there is no magnet link to resume from", async () => {
		mocks.getIncompleteDownloads.mockReturnValue([{ id: "m1", filePath: null, magnetLink: null }]);

		await recoverDownloads();

		expect(mocks.finalizeMediaToLibrary).toHaveBeenCalledTimes(1);
		expect(mocks.startDownload).not.toHaveBeenCalled();
	});
});
