import { mediaDb } from "$lib/server/db";
import type { Media } from "$lib/server/db/schema";
import { type BrowseItem, getRecommendations } from "$lib/server/tmdb";

const SEED_COUNT = 8;
const ROW_SIZE = 20;
const BECAUSE_ROWS = 2;

export interface RecommendationRow {
	title: string;
	items: BrowseItem[];
}

/**
 * Merge per-seed recommendation lists into one ranking. A title scores higher when
 * several seeds suggest it, when its seed was watched recently and when TMDB ranks it high.
 */
export function rankRecommendations(lists: BrowseItem[][], exclude: Set<string>): BrowseItem[] {
	const scored = new Map<string, { item: BrowseItem; score: number }>();
	lists.forEach((list, seedIndex) => {
		const seedWeight = 1 / (1 + seedIndex * 0.3);
		list.forEach((item, rank) => {
			const key = `${item.mediaType}:${item.tmdbId}`;
			if (exclude.has(key)) {
				return;
			}
			const entry = scored.get(key) ?? { item, score: 0 };
			entry.score += seedWeight * (1 - rank / 40);
			scored.set(key, entry);
		});
	});
	return [...scored.values()].sort((a, b) => b.score - a.score).map((entry) => entry.item);
}

function seedRecommendations(seed: Media): Promise<BrowseItem[]> {
	return getRecommendations(seed.tmdbId as number, seed.type === "show" ? "show" : "movie");
}

/** Home and browse rows for one profile, built from what it watched and added. */
export async function getForYouRows(organizationId: string): Promise<RecommendationRow[]> {
	const seeds = mediaDb.getRecommendationSeeds(organizationId, SEED_COUNT);
	const library = mediaDb.getLibraryTmdbKeys(organizationId);
	const [nowPlaying, ...lists] = await Promise.all([
		getRecommendations(null, "movie"),
		...seeds.map(seedRecommendations),
	]);

	const rows: RecommendationRow[] = [];
	const boxOffice = rankRecommendations([nowPlaying], library).slice(0, ROW_SIZE);
	if (boxOffice.length > 0) {
		rows.push({ title: "New in cinemas", items: boxOffice });
	}
	const forYou = rankRecommendations(lists, library).slice(0, ROW_SIZE);
	if (forYou.length > 0) {
		rows.push({ title: "Recommended for you", items: forYou });
	}
	// "Because you watched" rows skip titles already shown above, so the rows don't repeat each other
	const shown = new Set([...library, ...forYou.map((item) => `${item.mediaType}:${item.tmdbId}`)]);
	seeds.slice(0, BECAUSE_ROWS).forEach((seed, i) => {
		const items = rankRecommendations([lists[i]], shown).slice(0, ROW_SIZE);
		for (const item of items) {
			shown.add(`${item.mediaType}:${item.tmdbId}`);
		}
		if (items.length > 0) {
			rows.push({ title: `Because you watched ${seed.title}`, items });
		}
	});
	return rows;
}
