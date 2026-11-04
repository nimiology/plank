import { eq } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { decrypt, encrypt } from "$lib/server/crypto";
import { db } from "$lib/server/db/index";
import { configuration } from "$lib/server/db/schema";
import { type EncoderSetting, isEncoderSetting } from "$lib/server/encoder";

export interface AppSettings {
	tmdb: {
		apiKey: string;
		baseUrl: string;
		imageBaseUrl: string;
		language: string;
	};
	prowlarr: {
		url: string;
		apiKey: string;
		trustedGroups: string[];
		minSeeders: number;
	};
	opensubtitles: {
		apiKey: string;
		username: string;
		password: string;
	};
	playback: {
		encoder: EncoderSetting;
	};
	downloads: {
		engine: TorrentEngine;
		rqbitUrl: string;
	};
}

export const TORRENT_ENGINES = ["webtorrent", "rqbit"] as const;
export type TorrentEngine = (typeof TORRENT_ENGINES)[number];

export function isTorrentEngine(value: unknown): value is TorrentEngine {
	return typeof value === "string" && (TORRENT_ENGINES as readonly string[]).includes(value);
}

const DEFAULT_CONFIG: AppSettings = {
	tmdb: {
		apiKey: env.TMDB_API_KEY || "",
		baseUrl: "https://api.themoviedb.org/3",
		imageBaseUrl: "https://image.tmdb.org/t/p",
		language: "en-US",
	},
	prowlarr: {
		url: env.PROWLARR_URL || "http://localhost:9696",
		apiKey: env.PROWLARR_API_KEY || "",
		// Trusted release groups for high-quality content
		trustedGroups: ["YTS", "YIFY", ".BONE.", "x1337", "TVTEAM"],
		// Minimum seeders for a valid torrent
		minSeeders: 5,
	},
	opensubtitles: {
		apiKey: env.OPENSUBTITLES_API_KEY || "",
		username: env.OPENSUBTITLES_USERNAME || "",
		password: env.OPENSUBTITLES_PASSWORD || "",
	},
	playback: {
		encoder: isEncoderSetting(env.VIDEO_ENCODER) ? env.VIDEO_ENCODER : "auto",
	},
	downloads: {
		engine: isTorrentEngine(env.TORRENT_ENGINE) ? env.TORRENT_ENGINE : "webtorrent",
		rqbitUrl: env.RQBIT_URL || "http://127.0.0.1:3030",
	},
};

/** Fields stored encrypted at rest */
const ENCRYPTED_FIELDS = [
	"tmdbApiKey",
	"prowlarrApiKey",
	"opensubtitlesApiKey",
	"opensubtitlesUsername",
	"opensubtitlesPassword",
] as const;

/** Fields stored as plain text (or serialized JSON) */
const PLAIN_FIELDS = ["prowlarrUrl", "prowlarrMinSeeders", "videoEncoder", "torrentEngine", "rqbitUrl"] as const;

type SettingsUpdate = Partial<{
	tmdbApiKey: string;
	prowlarrUrl: string;
	prowlarrApiKey: string;
	prowlarrTrustedGroups: string[];
	prowlarrMinSeeders: number;
	opensubtitlesApiKey: string;
	opensubtitlesUsername: string;
	opensubtitlesPassword: string;
	videoEncoder: EncoderSetting;
	torrentEngine: TorrentEngine;
	rqbitUrl: string;
}>;

// In-memory cache for settings to avoid repeated DB queries + decryption
// TODO: I worry this cache will leak the users data to other clients. Will need to look into this
let settingsCache: AppSettings | null = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 60_000; // 1 minute

/** A saved value wins over env only once someone picks a non-default one in the UI. */
function readEngineSettings(
	stored: { videoEncoder?: string | null; torrentEngine?: string | null; rqbitUrl?: string | null } | undefined
): Pick<AppSettings, "playback" | "downloads"> {
	const encoder = stored?.videoEncoder;
	const engine = stored?.torrentEngine;
	return {
		playback: {
			encoder: isEncoderSetting(encoder) && encoder !== "auto" ? encoder : DEFAULT_CONFIG.playback.encoder,
		},
		downloads: {
			engine: isTorrentEngine(engine) && engine !== "webtorrent" ? engine : DEFAULT_CONFIG.downloads.engine,
			rqbitUrl: stored?.rqbitUrl || DEFAULT_CONFIG.downloads.rqbitUrl,
		},
	};
}

export async function getSettings(): Promise<AppSettings> {
	// Return cached settings if still fresh
	const now = Date.now();
	if (settingsCache && now - settingsCacheTime < SETTINGS_CACHE_TTL) {
		return settingsCache;
	}

	try {
		// Try to get from DB
		const stored = await db.query.configuration.findFirst({
			where: eq(configuration.id, "default"),
		});

		// Default trusted groups from env config
		const defaultTrustedGroups = DEFAULT_CONFIG.prowlarr.trustedGroups;

		// Parse trusted groups if stored
		let trustedGroups = defaultTrustedGroups;
		if (stored?.prowlarrTrustedGroups) {
			try {
				const parsed = JSON.parse(stored.prowlarrTrustedGroups);
				if (Array.isArray(parsed)) {
					trustedGroups = parsed;
				}
			} catch {
				// keep default
			}
		}

		const settings: AppSettings = {
			tmdb: {
				apiKey: decrypt(stored?.tmdbApiKey || "") || DEFAULT_CONFIG.tmdb.apiKey,
				baseUrl: DEFAULT_CONFIG.tmdb.baseUrl,
				imageBaseUrl: DEFAULT_CONFIG.tmdb.imageBaseUrl,
				language: "en-US",
			},
			prowlarr: {
				url: stored?.prowlarrUrl || DEFAULT_CONFIG.prowlarr.url,
				apiKey: decrypt(stored?.prowlarrApiKey || "") || DEFAULT_CONFIG.prowlarr.apiKey,
				trustedGroups,
				minSeeders: stored?.prowlarrMinSeeders ?? DEFAULT_CONFIG.prowlarr.minSeeders,
			},
			opensubtitles: {
				apiKey: decrypt(stored?.opensubtitlesApiKey || "") || DEFAULT_CONFIG.opensubtitles.apiKey,
				username: decrypt(stored?.opensubtitlesUsername || "") || DEFAULT_CONFIG.opensubtitles.username,
				password: decrypt(stored?.opensubtitlesPassword || "") || DEFAULT_CONFIG.opensubtitles.password,
			},
			...readEngineSettings(stored),
		};

		settingsCache = settings;
		settingsCacheTime = now;
		return settings;
	} catch (e) {
		console.error("Failed to load settings from DB, falling back to env:", e);
		return {
			tmdb: DEFAULT_CONFIG.tmdb,
			prowlarr: DEFAULT_CONFIG.prowlarr,
			opensubtitles: DEFAULT_CONFIG.opensubtitles,
			playback: DEFAULT_CONFIG.playback,
			downloads: DEFAULT_CONFIG.downloads,
		};
	}
}

/** Invalidate the settings cache (call after updateSettings) */
function invalidateSettingsCache(): void {
	settingsCache = null;
	settingsCacheTime = 0;
}

export async function updateSettings(updates: SettingsUpdate) {
	const values: Partial<typeof configuration.$inferInsert> = {};

	for (const field of ENCRYPTED_FIELDS) {
		if (updates[field] !== undefined) {
			values[field] = updates[field] ? encrypt(updates[field] as string) : "";
		}
	}

	for (const field of PLAIN_FIELDS) {
		if (updates[field] !== undefined) {
			(values as Record<string, unknown>)[field] = updates[field];
		}
	}

	if (updates.prowlarrTrustedGroups !== undefined) {
		values.prowlarrTrustedGroups = JSON.stringify(updates.prowlarrTrustedGroups);
	}

	await db
		.insert(configuration)
		.values({ id: "default", ...values })
		.onConflictDoUpdate({ target: configuration.id, set: values });

	invalidateSettingsCache();
}
