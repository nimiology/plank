import { sql } from "drizzle-orm";
import { type AnySQLiteColumn, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ============================================================================
// Auth tables
// ============================================================================

export const user = sqliteTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
	image: text("image"),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
		.$onUpdate(() => /* @__PURE__ */ new Date())
		.notNull(),
});

export const session = sqliteTable(
	"session",
	{
		id: text("id").primaryKey(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		token: text("token").notNull().unique(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		activeOrganizationId: text("active_organization_id"),
	},
	(table) => [index("session_userId_idx").on(table.userId)]
);

export const account = sqliteTable(
	"account",
	{
		id: text("id").primaryKey(),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: integer("access_token_expires_at", {
			mode: "timestamp_ms",
		}),
		refreshTokenExpiresAt: integer("refresh_token_expires_at", {
			mode: "timestamp_ms",
		}),
		scope: text("scope"),
		password: text("password"),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [index("account_userId_idx").on(table.userId)]
);

export const verification = sqliteTable(
	"verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)]
);

export const organization = sqliteTable("organization", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	slug: text("slug").notNull().unique(),
	logo: text("logo"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	metadata: text("metadata"),
});

export const member = sqliteTable(
	"member",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		role: text("role").default("member").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("member_organizationId_idx").on(table.organizationId),
		index("member_userId_idx").on(table.userId),
	]
);

export const invitation = sqliteTable(
	"invitation",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		role: text("role"),
		status: text("status").default("pending").notNull(),
		expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		inviterId: text("inviter_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("invitation_organizationId_idx").on(table.organizationId),
		index("invitation_email_idx").on(table.email),
	]
);

// ============================================================================
// Application tables
// ============================================================================

export const media = sqliteTable(
	"media",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		organizationId: text("organization_id").references(() => organization.id, { onDelete: "set null" }),
		type: text("type", { enum: ["movie", "show", "episode"] })
			.default("movie")
			.notNull(),
		title: text("title").notNull(),
		overview: text("overview"),
		year: integer("year"),
		voteAverage: real("vote_average"),
		tmdbId: integer("tmdb_id"),
		imdbId: text("imdb_id"),
		runtime: integer("runtime"),
		originalLanguage: text("original_language"),
		addedAt: integer("added_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
		posterUrl: text("poster_url"),
		backdropUrl: text("backdrop_url"),
		genres: text("genres"),
		certification: text("certification"),
		totalSeasons: integer("total_seasons"),
		parentId: text("parent_id").references((): AnySQLiteColumn => media.id, { onDelete: "cascade" }),
		seasonId: text("season_id").references((): AnySQLiteColumn => seasons.id, { onDelete: "cascade" }),
		episodeNumber: integer("episode_number"),
		seasonNumber: integer("season_number"),
		displayOrder: integer("display_order"),
		stillPath: text("still_path"),
		airDate: text("air_date"),
		magnetLink: text("magnet_link"),
		infohash: text("infohash"),
		status: text("status", {
			enum: ["pending", "searching", "downloading", "complete", "error", "not_found", "removed"],
		}).default("pending"),
		progress: real("progress").default(0),
		filePath: text("file_path"),
		fileSize: integer("file_size"),
		fileIndex: integer("file_index"),
		downloadedBytes: integer("downloaded_bytes").default(0),
		lastPlayedAt: integer("last_played_at", { mode: "timestamp_ms" }),
		playPosition: real("play_position").default(0),
		playDuration: real("play_duration"),
	},
	(table) => [
		uniqueIndex("media_organization_infohash_unique")
			.on(table.organizationId, table.infohash)
			.where(sql`${table.infohash} IS NOT NULL`),
		index("idx_media_user").on(table.userId),
		index("idx_media_status").on(table.status).where(sql`${table.status} IS NOT NULL`),
		index("idx_media_library").on(table.organizationId, table.type).where(sql`${table.type} IN ('movie', 'show')`),
		index("idx_media_episodes")
			.on(table.parentId, table.seasonId, table.displayOrder)
			.where(sql`${table.type} = 'episode'`),
		index("idx_media_organization").on(table.organizationId),
		index("idx_media_watching").on(table.organizationId, table.lastPlayedAt).where(sql`${table.playPosition} > 0`),
	]
);

export const seasons = sqliteTable(
	"seasons",
	{
		id: text("id").primaryKey(),
		mediaId: text("media_id")
			.notNull()
			.references((): AnySQLiteColumn => media.id, { onDelete: "cascade" }),
		seasonNumber: integer("season_number").notNull(),
		name: text("name"),
		episodeCount: integer("episode_count").default(0),
	},
	(table) => [uniqueIndex("seasons_media_number_unique").on(table.mediaId, table.seasonNumber)]
);

export const downloads = sqliteTable(
	"downloads",
	{
		id: text("id").primaryKey(),
		mediaId: text("media_id")
			.notNull()
			.references(() => media.id, { onDelete: "cascade" }),
		magnetLink: text("magnet_link").notNull(),
		infohash: text("infohash").notNull(),
		status: text("status", { enum: ["added", "downloading", "complete", "error"] }).default("added"),
		progress: real("progress").default(0),
		addedAt: integer("added_at", { mode: "timestamp_ms" })
			.default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
			.notNull(),
	},
	(table) => [
		uniqueIndex("downloads_media_infohash_unique").on(table.mediaId, table.infohash),
		index("idx_downloads_status").on(table.status),
	]
);

export const torrentCache = sqliteTable("torrent_cache", {
	imdbId: text("imdb_id").primaryKey(),
	magnetLink: text("magnet_link").notNull(),
	infohash: text("infohash").notNull(),
});

export const configuration = sqliteTable("configuration", {
	id: text("id")
		.primaryKey()
		.$default(() => "default"),
	tmdbApiKey: text("tmdb_api_key"),
	prowlarrUrl: text("prowlarr_url"),
	prowlarrApiKey: text("prowlarr_api_key"),
	prowlarrTrustedGroups: text("prowlarr_trusted_groups"), // JSON array
	prowlarrMinSeeders: integer("prowlarr_min_seeders").default(5),
	opensubtitlesApiKey: text("opensubtitles_api_key"),
	opensubtitlesUsername: text("opensubtitles_username"),
	opensubtitlesPassword: text("opensubtitles_password"),
	videoEncoder: text("video_encoder").default("auto"),
	torrentEngine: text("torrent_engine").default("webtorrent"),
	rqbitUrl: text("rqbit_url"),
});

export const subtitles = sqliteTable(
	"subtitles",
	{
		id: text("id").primaryKey(),
		mediaId: text("media_id")
			.notNull()
			.references(() => media.id, { onDelete: "cascade" }),
		language: text("language").notNull(),
		label: text("label").notNull(),
		source: text("source", { enum: ["sidecar", "embedded", "opensubtitles", "manual"] }).notNull(),
		filePath: text("file_path"),
	},
	(table) => [index("idx_subtitles_media").on(table.mediaId)]
);

// ============================================================================
// Type exports
// ============================================================================

export type Media = typeof media.$inferSelect;
export type NewMedia = typeof media.$inferInsert;
export type Season = typeof seasons.$inferSelect;
export type NewSeason = typeof seasons.$inferInsert;
export type Download = typeof downloads.$inferSelect;
export type NewDownload = typeof downloads.$inferInsert;
export type Subtitle = typeof subtitles.$inferSelect;
export type NewSubtitle = typeof subtitles.$inferInsert;

// ============================================================================
// Tables object for consolidated import
// ============================================================================

export const schema = {
	user,
	session,
	account,
	verification,
	organization,
	member,
	invitation,
	media,
	seasons,
	downloads,
	torrentCache,
	configuration,
	subtitles,
} as const;
