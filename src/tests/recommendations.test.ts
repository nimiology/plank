import { describe, expect, it } from "vitest";
import { rankRecommendations } from "$lib/server/recommendations";
import type { BrowseItem } from "$lib/server/tmdb";

function item(tmdbId: number, mediaType: "movie" | "show" = "movie"): BrowseItem {
	return { tmdbId, mediaType, title: `T${tmdbId}` } as BrowseItem;
}

describe("rankRecommendations", () => {
	it("ranks titles suggested by several seeds first", () => {
		const ranked = rankRecommendations(
			[
				[item(1), item(2)],
				[item(3), item(2)],
			],
			new Set()
		);
		expect(ranked[0].tmdbId).toBe(2);
		expect(ranked).toHaveLength(3);
	});

	it("drops titles already in the library", () => {
		const ranked = rankRecommendations([[item(1), item(2), item(1, "show")]], new Set(["movie:1"]));
		expect(ranked.map((r) => `${r.mediaType}:${r.tmdbId}`)).toEqual(["movie:2", "show:1"]);
	});

	it("keeps a movie and a show with the same TMDB id apart", () => {
		const ranked = rankRecommendations([[item(5, "movie"), item(5, "show")]], new Set());
		expect(ranked).toHaveLength(2);
	});
});
