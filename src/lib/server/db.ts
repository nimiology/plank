import { and, asc, desc, eq, gte, inArray, isNull, like, lte, notExists, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type CatalogFilters, getCatalogGenreLabels } from "$lib/data/search";
import {
	type Download,
	downloads as downloadsTable,
	type Media,
	media as mediaTable,
	type NewDownload,
	type NewMedia,
	type NewSeason,
	type NewSubtitle,
	type Season,
	type Subtitle,
	seasons as seasonsTable,
	subtitles as subtitlesTable,
} from "$lib/server/db/schema";
import type { MediaType } from "$lib/types";
import { db } from "./db/index";

function removeUndefinedFromObject<T extends Record<string, unknown>>(obj: T): Partial<T> {
	return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function getCatalogMediaConditions(organizationId: string, query: string, filters: CatalogFilters): SQL[] {
	const conditions: SQL[] = [
		eq(mediaTable.organizationId, organizationId),
		sql`${mediaTable.type} IN ('movie', 'show')`,
	];
	if (query) {
		conditions.push(sql`instr(lower(${mediaTable.title}), lower(${query})) > 0`);
	}
	if (filters.media !== "all") {
		conditions.push(eq(mediaTable.type, filters.media));
	}
	if (filters.rating > 0) {
		const ratingFilter = or(isNull(mediaTable.voteAverage), gte(mediaTable.voteAverage, filters.rating));
		if (ratingFilter) {
			conditions.push(ratingFilter);
		}
	}
	if (filters.yearFrom !== null) {
		conditions.push(gte(mediaTable.year, filters.yearFrom));
	}
	if (filters.yearTo !== null) {
		conditions.push(lte(mediaTable.year, filters.yearTo));
	}
	const genreConditions = getCatalogGenreLabels(filters.genres).map((genre) =>
		like(mediaTable.genres, `%"${genre}"%`)
	);
	if (genreConditions.length > 0) {
		const genreFilter = or(...genreConditions);
		if (genreFilter) {
			conditions.push(genreFilter);
		}
	}
	return conditions;
}

/** Statuses that mean the download stopped and the user can retry it with a new source. */
const DOWNLOAD_ERROR_STATUSES = ["error", "not_found"] as const;

/** Statuses that mean work is queued or running. */
const DOWNLOAD_ACTIVE_STATUSES = ["pending", "searching", "downloading"] as const;

const QUEUE_STATUSES = [...DOWNLOAD_ERROR_STATUSES, ...DOWNLOAD_ACTIVE_STATUSES] as const;

/** Download records that still belong in the queue. */
const QUEUED_DOWNLOAD_STATUSES = ["added", "downloading", "error"] as const;

/** Hard bounds for one queue snapshot. */
const QUEUE_ROW_LIMIT = 500;

const parentMediaTable = alias(mediaTable, "parent_media");

/** One raw queue row and the download that owns it, when one exists. */
export interface QueueRow {
	media: Media;
	showTitle: string | null;
	download: Download | null;
	queuedAt: Date;
}

export const mediaDb = {
	countDownloadErrors(organizationId: string): number {
		const row = db
			.select({ total: sql<number>`count(*)` })
			.from(mediaTable)
			.where(
				and(
					eq(mediaTable.organizationId, organizationId),
					inArray(mediaTable.status, [...DOWNLOAD_ERROR_STATUSES])
				)
			)
			.get();
		return row?.total ?? 0;
	},

	/** Every failed or in-flight row, newest first. Covers movies, shows, and episodes. */
	listQueueRows(organizationId: string): QueueRow[] {
		const queuedDownloadExists = db
			.select({ id: downloadsTable.id })
			.from(downloadsTable)
			.where(
				and(
					eq(downloadsTable.mediaId, mediaTable.id),
					inArray(downloadsTable.status, [...QUEUED_DOWNLOAD_STATUSES])
				)
			);
		const downloadRows: QueueRow[] = db
			.select({ media: mediaTable, showTitle: parentMediaTable.title, download: downloadsTable })
			.from(downloadsTable)
			.innerJoin(mediaTable, eq(downloadsTable.mediaId, mediaTable.id))
			.leftJoin(parentMediaTable, eq(mediaTable.parentId, parentMediaTable.id))
			.where(
				and(
					eq(mediaTable.organizationId, organizationId),
					inArray(downloadsTable.status, [...QUEUED_DOWNLOAD_STATUSES])
				)
			)
			.orderBy(desc(downloadsTable.addedAt))
			.limit(QUEUE_ROW_LIMIT)
			.all()
			.map((row) => ({ ...row, queuedAt: row.download.addedAt }));
		const mediaRows: QueueRow[] = db
			.select({ media: mediaTable, showTitle: parentMediaTable.title })
			.from(mediaTable)
			.leftJoin(parentMediaTable, eq(mediaTable.parentId, parentMediaTable.id))
			.where(
				and(
					eq(mediaTable.organizationId, organizationId),
					inArray(mediaTable.status, [...QUEUE_STATUSES]),
					notExists(queuedDownloadExists)
				)
			)
			.orderBy(desc(mediaTable.addedAt))
			.limit(QUEUE_ROW_LIMIT)
			.all()
			.map((row) => ({ ...row, download: null, queuedAt: row.media.addedAt }));
		return [...downloadRows, ...mediaRows]
			.sort((a, b) => b.queuedAt.getTime() - a.queuedAt.getTime())
			.slice(0, QUEUE_ROW_LIMIT);
	},
	list(organizationId: string, type?: MediaType): Media[] {
		const conditions = [eq(mediaTable.organizationId, organizationId)];
		if (type) {
			conditions.push(eq(mediaTable.type, type));
		}
		return db
			.select()
			.from(mediaTable)
			.where(and(...conditions))
			.orderBy(desc(mediaTable.addedAt))
			.all();
	},
	search(organizationId: string, query: string, filters: CatalogFilters, limit = 21, offset = 0): Media[] {
		const conditions = getCatalogMediaConditions(organizationId, query, filters);

		const boundedLimit = Math.min(2000, Math.max(1, limit));
		const boundedOffset = Math.max(0, offset);
		const selection = db
			.select()
			.from(mediaTable)
			.where(and(...conditions));
		switch (filters.sort) {
			case "rating":
			case "popular":
				return selection
					.orderBy(desc(mediaTable.voteAverage), desc(mediaTable.addedAt))
					.limit(boundedLimit)
					.offset(boundedOffset)
					.all();
			case "newest":
				return selection
					.orderBy(desc(mediaTable.year), desc(mediaTable.addedAt))
					.limit(boundedLimit)
					.offset(boundedOffset)
					.all();
			case "oldest":
				return selection
					.orderBy(sql`${mediaTable.year} IS NULL`, asc(mediaTable.year), desc(mediaTable.addedAt))
					.limit(boundedLimit)
					.offset(boundedOffset)
					.all();
			default:
				return selection
					.orderBy(
						sql`CASE
							WHEN lower(${mediaTable.title}) = lower(${query}) THEN 0
							WHEN instr(lower(${mediaTable.title}), lower(${query})) = 1 THEN 1
							ELSE 2
						END`,
						desc(mediaTable.addedAt)
					)
					.limit(boundedLimit)
					.offset(boundedOffset)
					.all();
		}
	},
	searchIdentities(
		organizationId: string,
		query: string,
		filters: CatalogFilters,
		candidates: Array<{
			mediaType: "movie" | "show";
			tmdbId: number;
			imdbId: string | null;
			title: string;
			year: number | null;
		}>
	) {
		if (candidates.length === 0) {
			return [];
		}
		const candidateConditions = candidates.map((item) => {
			const imdbMatch = item.imdbId === null ? sql`0` : eq(mediaTable.imdbId, item.imdbId);
			const yearMatch = item.year === null ? isNull(mediaTable.year) : eq(mediaTable.year, item.year);
			return sql`(
				(${mediaTable.type} = ${item.mediaType} AND ${mediaTable.tmdbId} = ${item.tmdbId})
				OR ${imdbMatch}
				OR (
					${mediaTable.type} = ${item.mediaType}
					AND lower(${mediaTable.title}) = lower(${item.title})
					AND ${yearMatch}
				)
			)`;
		});
		const candidateFilter = or(...candidateConditions);
		if (!candidateFilter) {
			return [];
		}
		return db
			.select({
				type: mediaTable.type,
				title: mediaTable.title,
				year: mediaTable.year,
				tmdbId: mediaTable.tmdbId,
				imdbId: mediaTable.imdbId,
			})
			.from(mediaTable)
			.where(and(...getCatalogMediaConditions(organizationId, query, filters), candidateFilter))
			.groupBy(mediaTable.type, mediaTable.title, mediaTable.year, mediaTable.tmdbId, mediaTable.imdbId)
			.limit(candidates.length * 3)
			.all();
	},

	getAll(): Media[] {
		return db.select().from(mediaTable).all();
	},

	getIncompleteDownloads(): Media[] {
		return db
			.select()
			.from(mediaTable)
			.where(sql`${mediaTable.status} IN ('pending', 'searching', 'downloading')`)
			.all();
	},

	get(id: string, organizationId: string): Media | undefined {
		return db
			.select()
			.from(mediaTable)
			.where(and(eq(mediaTable.id, id), eq(mediaTable.organizationId, organizationId)))
			.get();
	},

	getByInfohash(infohash: string, organizationId: string): Media | undefined {
		return db
			.select()
			.from(mediaTable)
			.where(and(eq(mediaTable.infohash, infohash), eq(mediaTable.organizationId, organizationId)))
			.get();
	},

	getById(id: string): Media | undefined {
		return db.select().from(mediaTable).where(eq(mediaTable.id, id)).get();
	},

	getByTmdbId(tmdbId: number, organizationId: string, type: MediaType): Media | undefined {
		return db
			.select()
			.from(mediaTable)
			.where(
				and(
					eq(mediaTable.tmdbId, tmdbId),
					eq(mediaTable.organizationId, organizationId),
					eq(mediaTable.type, type)
				)
			)
			.get();
	},

	create(mediaItem: Omit<NewMedia, "id" | "addedAt"> & { type?: MediaType }): Media {
		const id = crypto.randomUUID();
		const now = new Date();
		const type = mediaItem.type ?? "movie";
		const newMedia: NewMedia = {
			id,
			userId: mediaItem.userId,
			organizationId: mediaItem.organizationId ?? null,
			type,
			title: mediaItem.title,
			overview: mediaItem.overview,
			year: mediaItem.year,
			voteAverage: mediaItem.voteAverage,
			tmdbId: mediaItem.tmdbId,
			imdbId: mediaItem.imdbId,
			runtime: mediaItem.runtime,
			originalLanguage: mediaItem.originalLanguage,
			addedAt: now,
			posterUrl: mediaItem.posterUrl,
			backdropUrl: mediaItem.backdropUrl,
			genres: mediaItem.genres,
			certification: mediaItem.certification,
			totalSeasons: mediaItem.totalSeasons,
			parentId: mediaItem.parentId,
			seasonId: mediaItem.seasonId,
			episodeNumber: mediaItem.episodeNumber,
			seasonNumber: mediaItem.seasonNumber,
			displayOrder: mediaItem.displayOrder,
			stillPath: mediaItem.stillPath,
			airDate: mediaItem.airDate,
			magnetLink: mediaItem.magnetLink,
			infohash: mediaItem.infohash,
			status: mediaItem.status ?? (type === "show" ? null : "pending"),
			progress: mediaItem.progress ?? (type === "show" ? null : 0),
			filePath: mediaItem.filePath,
			fileSize: mediaItem.fileSize,
			fileIndex: mediaItem.fileIndex,
			downloadedBytes: mediaItem.downloadedBytes ?? 0,
			lastPlayedAt: mediaItem.lastPlayedAt,
			playPosition: mediaItem.playPosition ?? 0,
			playDuration: mediaItem.playDuration,
		};
		db.insert(mediaTable).values(newMedia).run();
		return newMedia as Media;
	},

	update(id: string, data: Partial<Omit<NewMedia, "id" | "addedAt">>) {
		const updates = removeUndefinedFromObject(data as Record<string, unknown>);
		if (Object.keys(updates).length === 0) {
			return;
		}
		db.update(mediaTable).set(updates).where(eq(mediaTable.id, id)).run();
	},

	updateProgress(
		id: string,
		progress: number,
		status: "pending" | "searching" | "downloading" | "complete" | "error" | "not_found" | "removed"
	) {
		db.update(mediaTable).set({ progress, status }).where(eq(mediaTable.id, id)).run();
	},

	resetDownload(id: string) {
		db.update(mediaTable)
			.set({
				progress: 0,
				status: "pending",
				filePath: null,
				fileSize: null,
				fileIndex: null,
				downloadedBytes: 0,
			})
			.where(eq(mediaTable.id, id))
			.run();
	},

	updateFilePath(id: string, filePath: string, fileSize?: number) {
		db.update(mediaTable)
			.set({ filePath, fileSize: fileSize ?? null, status: "complete", progress: 1 })
			.where(eq(mediaTable.id, id))
			.run();
	},

	updateFileInfo(
		id: string,
		data: { fileIndex?: number | null; filePath?: string | null; fileSize?: number | null }
	) {
		const updates = removeUndefinedFromObject(data);
		if (Object.keys(updates).length === 0) {
			return;
		}
		db.update(mediaTable).set(updates).where(eq(mediaTable.id, id)).run();
	},

	updateEpisodeProgress(
		id: string,
		downloadedBytes: number,
		status: "pending" | "searching" | "downloading" | "complete" | "error" | "not_found" | "removed"
	) {
		db.update(mediaTable).set({ downloadedBytes, status }).where(eq(mediaTable.id, id)).run();
	},

	markDownloadRemoved(id: string) {
		db.update(mediaTable)
			.set({
				progress: 0,
				status: "removed",
				filePath: null,
				fileSize: null,
				fileIndex: null,
				downloadedBytes: 0,
			})
			.where(eq(mediaTable.id, id))
			.run();
	},

	delete(id: string, organizationId: string) {
		db.delete(mediaTable)
			.where(and(eq(mediaTable.id, id), eq(mediaTable.organizationId, organizationId)))
			.run();
	},

	updateLastPlayed(id: string) {
		db.update(mediaTable).set({ lastPlayedAt: new Date() }).where(eq(mediaTable.id, id)).run();
	},

	updatePlayPosition(id: string, position: number, duration?: number) {
		const updates = removeUndefinedFromObject({ playPosition: position, playDuration: duration });
		db.update(mediaTable).set(updates).where(eq(mediaTable.id, id)).run();
	},

	/** Finish playback so getRecentlyWatched drops the row. */
	markWatched(id: string) {
		db.update(mediaTable)
			.set({ playPosition: sql`COALESCE(${mediaTable.playDuration}, 0)` })
			.where(eq(mediaTable.id, id))
			.run();
	},

	getRecentlyWatched(organizationId: string, limit = 20): Media[] {
		return db
			.select()
			.from(mediaTable)
			.where(
				and(
					eq(mediaTable.organizationId, organizationId),
					sql`${mediaTable.type} IN ('movie', 'episode')`,
					sql`${mediaTable.lastPlayedAt} IS NOT NULL`,
					sql`${mediaTable.playPosition} > 0`,
					sql`(${mediaTable.playDuration} IS NULL OR ${mediaTable.playPosition} < ${mediaTable.playDuration} * 0.95)`
				)
			)
			.orderBy(desc(mediaTable.lastPlayedAt))
			.limit(limit)
			.all();
	},

	updateMetadata(
		id: string,
		metadata: {
			title?: string;
			year?: number | null;
			voteAverage?: number | null;
			posterUrl?: string | null;
			backdropUrl?: string | null;
			overview?: string | null;
			tmdbId?: number | null;
			imdbId?: string | null;
			runtime?: number | null;
			genres?: string | null;
			originalLanguage?: string | null;
			certification?: string | null;
			totalSeasons?: number | null;
			type?: MediaType;
		}
	) {
		const updates = removeUndefinedFromObject(metadata as Record<string, unknown>);
		if (Object.keys(updates).length === 0) {
			return;
		}
		db.update(mediaTable).set(updates).where(eq(mediaTable.id, id)).run();
	},

	/** Library movies and shows, most recently watched first (a show counts its episodes' plays), then newest added. */
	getRecommendationSeeds(organizationId: string, limit = 10): Media[] {
		const lastWatched = sql`COALESCE(
			(SELECT MAX(e.last_played_at) FROM media e WHERE e.parent_id = ${mediaTable.id}),
			${mediaTable.lastPlayedAt}
		)`;
		return db
			.select()
			.from(mediaTable)
			.where(
				and(
					eq(mediaTable.organizationId, organizationId),
					sql`${mediaTable.type} IN ('movie', 'show')`,
					sql`${mediaTable.tmdbId} IS NOT NULL`
				)
			)
			.orderBy(sql`${lastWatched} IS NULL`, desc(lastWatched), desc(mediaTable.addedAt))
			.limit(limit)
			.all();
	},

	/** "movie:603" / "show:1396" keys, since TMDB movie and show ids overlap. */
	getLibraryTmdbKeys(organizationId: string): Set<string> {
		const rows = db
			.select({ type: mediaTable.type, tmdbId: mediaTable.tmdbId })
			.from(mediaTable)
			.where(
				and(
					eq(mediaTable.organizationId, organizationId),
					sql`${mediaTable.type} IN ('movie', 'show')`,
					sql`${mediaTable.tmdbId} IS NOT NULL`
				)
			)
			.all();
		return new Set(rows.map((row) => `${row.type}:${row.tmdbId}`));
	},

	getEpisodesBySeasonId(seasonId: string): Media[] {
		return db
			.select()
			.from(mediaTable)
			.where(and(eq(mediaTable.type, "episode"), eq(mediaTable.seasonId, seasonId)))
			.orderBy(asc(mediaTable.displayOrder), asc(mediaTable.episodeNumber))
			.all();
	},

	getEpisodesByParentId(parentId: string): Media[] {
		return db
			.select()
			.from(mediaTable)
			.where(and(eq(mediaTable.type, "episode"), eq(mediaTable.parentId, parentId)))
			.orderBy(asc(mediaTable.seasonNumber), asc(mediaTable.displayOrder), asc(mediaTable.episodeNumber))
			.all();
	},

	getNextEpisodeById(id: string): Media | null {
		const mediaItem = this.getById(id);
		if (!mediaItem || mediaItem.type !== "episode" || !mediaItem.parentId) {
			return null;
		}

		const episodes = this.getEpisodesByParentId(mediaItem.parentId);
		const currentIndex = episodes.findIndex((episode) => episode.id === mediaItem.id);
		if (currentIndex === -1) {
			return null;
		}

		return episodes[currentIndex + 1] ?? null;
	},

	getEpisodeBySeasonAndNumber(seasonId: string, episodeNumber: number): Media | undefined {
		return db
			.select()
			.from(mediaTable)
			.where(
				and(
					eq(mediaTable.type, "episode"),
					eq(mediaTable.seasonId, seasonId),
					eq(mediaTable.episodeNumber, episodeNumber)
				)
			)
			.get();
	},

	getEpisodeByParentAndNumber(parentId: string, seasonNumber: number, episodeNumber: number): Media | undefined {
		return db
			.select()
			.from(mediaTable)
			.where(
				and(
					eq(mediaTable.type, "episode"),
					eq(mediaTable.parentId, parentId),
					eq(mediaTable.seasonNumber, seasonNumber),
					eq(mediaTable.episodeNumber, episodeNumber)
				)
			)
			.get();
	},
};

export const seasonsDb = {
	create(season: Omit<NewSeason, "id">): Season {
		const id = crypto.randomUUID();
		const newSeason: NewSeason = {
			id,
			mediaId: season.mediaId,
			seasonNumber: season.seasonNumber,
			name: season.name,
			episodeCount: season.episodeCount,
		};
		db.insert(seasonsTable).values(newSeason).run();
		return newSeason as Season;
	},

	getByMediaId(mediaId: string): Season[] {
		return db
			.select()
			.from(seasonsTable)
			.where(eq(seasonsTable.mediaId, mediaId))
			.orderBy(asc(seasonsTable.seasonNumber))
			.all();
	},
	getWithEpisodes(mediaId: string) {
		return this.getByMediaId(mediaId).map((season) => ({
			...season,
			episodes: mediaDb.getEpisodesBySeasonId(season.id),
		}));
	},

	getById(id: string): Season | undefined {
		return db.select().from(seasonsTable).where(eq(seasonsTable.id, id)).get();
	},

	getByMediaAndNumber(mediaId: string, seasonNumber: number): Season | undefined {
		return db
			.select()
			.from(seasonsTable)
			.where(and(eq(seasonsTable.mediaId, mediaId), eq(seasonsTable.seasonNumber, seasonNumber)))
			.get();
	},

	update(id: string, data: Partial<Omit<NewSeason, "id">>) {
		const updates = removeUndefinedFromObject(data as Record<string, unknown>);
		if (Object.keys(updates).length === 0) {
			return;
		}
		db.update(seasonsTable).set(updates).where(eq(seasonsTable.id, id)).run();
	},

	updateEpisodeCount(id: string, count: number) {
		db.update(seasonsTable).set({ episodeCount: count }).where(eq(seasonsTable.id, id)).run();
	},
};

export const downloadsDb = {
	create(download: Omit<NewDownload, "id" | "addedAt">): Download {
		const id = crypto.randomUUID();
		const now = new Date();
		const newDownload: NewDownload = {
			id,
			mediaId: download.mediaId,
			magnetLink: download.magnetLink,
			infohash: download.infohash,
			status: download.status || "added",
			progress: download.progress || 0,
			addedAt: now,
		};
		db.insert(downloadsTable).values(newDownload).run();
		return { ...newDownload, addedAt: now } as Download;
	},

	getByMediaId(mediaId: string): Download[] {
		return db
			.select()
			.from(downloadsTable)
			.where(eq(downloadsTable.mediaId, mediaId))
			.orderBy(desc(downloadsTable.addedAt))
			.all();
	},

	getByInfohash(mediaId: string, infohash: string): Download | undefined {
		return db
			.select()
			.from(downloadsTable)
			.where(and(eq(downloadsTable.mediaId, mediaId), eq(downloadsTable.infohash, infohash)))
			.get();
	},

	infohashExistsForOrg(infohash: string, organizationId: string): { download: Download; media: Media } | undefined {
		return db
			.select({
				download: downloadsTable,
				media: mediaTable,
			})
			.from(downloadsTable)
			.innerJoin(mediaTable, eq(downloadsTable.mediaId, mediaTable.id))
			.where(and(eq(downloadsTable.infohash, infohash), eq(mediaTable.organizationId, organizationId)))
			.get();
	},

	updateProgress(id: string, progress: number, status: "added" | "downloading" | "complete" | "error") {
		db.update(downloadsTable).set({ progress, status }).where(eq(downloadsTable.id, id)).run();
	},

	updateSource(id: string, magnetLink: string, infohash: string) {
		db.update(downloadsTable)
			.set({ magnetLink, infohash, progress: 0, status: "added" })
			.where(eq(downloadsTable.id, id))
			.run();
	},

	getById(id: string): Download | undefined {
		return db.select().from(downloadsTable).where(eq(downloadsTable.id, id)).get();
	},

	delete(id: string) {
		db.delete(downloadsTable).where(eq(downloadsTable.id, id)).run();
	},

	deleteByMediaId(mediaId: string) {
		db.delete(downloadsTable).where(eq(downloadsTable.mediaId, mediaId)).run();
	},
};

export const subtitlesDb = {
	create(subtitle: Omit<NewSubtitle, "id">): Subtitle {
		const id = crypto.randomUUID();
		return db
			.insert(subtitlesTable)
			.values({ id, ...subtitle })
			.returning()
			.get();
	},

	getByMediaId(mediaId: string): Subtitle[] {
		return db.select().from(subtitlesTable).where(eq(subtitlesTable.mediaId, mediaId)).all();
	},

	getById(id: string): Subtitle | undefined {
		return db.select().from(subtitlesTable).where(eq(subtitlesTable.id, id)).get();
	},

	deleteById(id: string) {
		db.delete(subtitlesTable).where(eq(subtitlesTable.id, id)).run();
	},
};
