import { describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/private", () => ({ env: { BETTER_AUTH_SECRET: "test-secret-for-signing" } }));
vi.mock("../lib/server/settings", () => ({ getSettings: vi.fn() }));
vi.mock("../lib/server/db", () => ({}));

import { buildBoundaries } from "../lib/server/hls";
import { createMediaToken, verifyMediaToken } from "../lib/server/media-token";

describe("HLS segment boundaries", () => {
	it("cuts converted video every 4 seconds and ends at the duration", () => {
		expect(buildBoundaries(10, null)).toEqual([0, 4, 8, 10]);
	});

	it("cuts copied video only on keyframes at least 4 seconds apart", () => {
		expect(buildBoundaries(20, [0, 2, 3, 5, 9.5, 11, 14, 19])).toEqual([0, 5, 9.5, 14, 19, 20]);
	});

	it("never adds a keyframe at or past the end", () => {
		expect(buildBoundaries(12, [0, 6, 12])).toEqual([0, 6, 12]);
	});
});

describe("signed media links", () => {
	it("accepts a fresh token for the same media only", () => {
		const token = createMediaToken("movie-1", 1000);
		expect(verifyMediaToken("movie-1", token, 2000)).toBe(true);
		expect(verifyMediaToken("movie-2", token, 2000)).toBe(false);
	});

	it("rejects expired, tampered and missing tokens", () => {
		const token = createMediaToken("movie-1", 0);
		expect(verifyMediaToken("movie-1", token, 13 * 60 * 60 * 1000)).toBe(false);
		expect(verifyMediaToken("movie-1", `${token}x`, 1)).toBe(false);
		expect(verifyMediaToken("movie-1", null, 1)).toBe(false);
	});
});
