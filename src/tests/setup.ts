import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeAll, beforeEach, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// Create a test database
const testDb = new Database(":memory:");
testDb.pragma("journal_mode = WAL");

export const db = drizzle(testDb, { schema });

// Mock environment variables
vi.mock("$env/dynamic/private", () => ({
	env: {
		DATABASE_URL: ":memory:",
		BETTER_AUTH_SECRET: "test-secret-key-for-testing-purposes",
		BETTER_AUTH_URL: "http://localhost:5173",
		TMDB_API_KEY: "test-tmdb-api-key",
		DATA_PATH: "/mock/data",
		PROWLARR_URL: "http://localhost:9696",
		PROWLARR_API_KEY: "test-api-key",
	},
}));

// Mock the database module to use our test instance
vi.mock("$lib/server/db/index", async () => {
	return {
		db: drizzle(testDb, { schema }),
	};
});

// Create tables before all tests
beforeAll(() => {
	// Create user table
	testDb.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER DEFAULT 0 NOT NULL,
      image TEXT,
      created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
      updated_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
    );
  `);

	// Create organization table
	testDb.exec(`
    CREATE TABLE IF NOT EXISTS organization (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      logo TEXT,
      metadata TEXT,
      created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
    );
  `);

	// Create member table
	testDb.exec(`
    CREATE TABLE IF NOT EXISTS member (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member' NOT NULL,
      created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
      UNIQUE(user_id, organization_id)
    );
  `);

	// Create invitation table
	testDb.exec(`
    CREATE TABLE IF NOT EXISTS invitation (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      inviter_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member' NOT NULL,
      status TEXT DEFAULT 'pending' NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
    );
  `);

	// Create session table
	testDb.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
      updated_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      active_organization_id TEXT REFERENCES organization(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS session_active_organization_idx ON session(active_organization_id);
  `);

	// Create account table
	testDb.exec(`
    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at INTEGER,
      refresh_token_expires_at INTEGER,
      scope TEXT,
      password TEXT,
      created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

	// Create verification table
	testDb.exec(`
    CREATE TABLE IF NOT EXISTS verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
      updated_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
    );
  `);

	// Create unified media table
	testDb.exec(`
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      organization_id TEXT REFERENCES organization(id) ON DELETE SET NULL,
      type TEXT DEFAULT 'movie' NOT NULL,
      title TEXT NOT NULL,
      overview TEXT,
      year INTEGER,
      vote_average REAL,
      tmdb_id INTEGER,
      imdb_id TEXT,
      runtime INTEGER,
      original_language TEXT,
      added_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
      poster_url TEXT,
      backdrop_url TEXT,
      genres TEXT,
      certification TEXT,
      total_seasons INTEGER,
      parent_id TEXT REFERENCES media(id) ON DELETE CASCADE,
      season_id TEXT REFERENCES seasons(id) ON DELETE CASCADE,
      episode_number INTEGER,
      season_number INTEGER,
      display_order INTEGER,
      still_path TEXT,
      air_date TEXT,
      magnet_link TEXT,
      infohash TEXT,
      status TEXT DEFAULT 'pending',
      progress REAL DEFAULT 0,
      file_path TEXT,
      file_size INTEGER,
      file_index INTEGER,
      downloaded_bytes INTEGER DEFAULT 0,
      last_played_at INTEGER,
      play_position REAL DEFAULT 0,
      play_duration REAL,
      UNIQUE(organization_id, infohash)
    );
  `);

	// Create indexes for media table
	testDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_media_user ON media(user_id);
    CREATE INDEX IF NOT EXISTS idx_media_status ON media(status) WHERE status IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_media_type ON media(organization_id, type);
    CREATE INDEX IF NOT EXISTS idx_media_organization ON media(organization_id);
    CREATE INDEX IF NOT EXISTS idx_media_episodes ON media(parent_id, season_id, display_order) WHERE type = 'episode';
  `);

	// Create seasons table for TV shows
	testDb.exec(`
    CREATE TABLE IF NOT EXISTS seasons (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      season_number INTEGER NOT NULL,
      name TEXT,
      episode_count INTEGER DEFAULT 0,
      UNIQUE(media_id, season_number)
    );
  `);

	// Create downloads table for tracking multiple torrents per media
	testDb.exec(`
    CREATE TABLE IF NOT EXISTS downloads (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      magnet_link TEXT NOT NULL,
      infohash TEXT NOT NULL,
      status TEXT DEFAULT 'added',
      progress REAL DEFAULT 0,
      added_at INTEGER DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
      UNIQUE(media_id, infohash)
    );
    CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
  `);

	// Create configuration table
	testDb.exec(`
    CREATE TABLE IF NOT EXISTS configuration (
      id TEXT PRIMARY KEY,
      tmdb_api_key TEXT,
      prowlarr_url TEXT,
      prowlarr_api_key TEXT,
      prowlarr_trusted_groups TEXT,
      prowlarr_min_seeders INTEGER DEFAULT 5,
      opensubtitles_api_key TEXT,
      opensubtitles_username TEXT,
      opensubtitles_password TEXT,
      video_encoder TEXT DEFAULT 'auto',
      torrent_engine TEXT DEFAULT 'webtorrent',
      rqbit_url TEXT
    );
  `);

	// Create subtitles table
	testDb.exec(`
    CREATE TABLE IF NOT EXISTS subtitles (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      label TEXT NOT NULL,
      source TEXT NOT NULL,
      file_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subtitles_media ON subtitles(media_id);
  `);
});

// Clean tables before each test
beforeEach(() => {
	testDb.exec("DELETE FROM subtitles");
	testDb.exec("DELETE FROM seasons");
	testDb.exec("DELETE FROM downloads");
	testDb.exec("DELETE FROM configuration");
	testDb.exec("DELETE FROM media");
	testDb.exec("DELETE FROM invitation");
	testDb.exec("DELETE FROM member");
	testDb.exec("DELETE FROM session");
	testDb.exec("DELETE FROM account");
	testDb.exec("DELETE FROM verification");
	testDb.exec("DELETE FROM organization");
	testDb.exec("DELETE FROM user");
	testDb.exec("INSERT INTO configuration (id, prowlarr_min_seeders) VALUES ('default', 5)");
});

afterAll(() => {
	testDb.close();
});

// Export testDb for direct SQL access in tests
export { testDb };
