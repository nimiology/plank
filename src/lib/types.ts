export type MediaType = "movie" | "show" | "episode";

export type MediaStatus = "pending" | "searching" | "downloading" | "complete" | "error" | "not_found" | "removed";

export interface Media {
	id: string;
	userId: string;
	organizationId: string | null;
	type: MediaType;
	title: string;
	overview: string | null;
	year: number | null;
	voteAverage: number | null;
	tmdbId: number | null;
	imdbId: string | null;
	runtime: number | null;
	originalLanguage: string | null;
	addedAt: Date;
	posterUrl: string | null;
	backdropUrl: string | null;
	genres: string | null;
	certification: string | null;
	totalSeasons: number | null;
	parentId: string | null;
	seasonId: string | null;
	episodeNumber: number | null;
	seasonNumber: number | null;
	displayOrder: number | null;
	stillPath: string | null;
	airDate: string | null;
	magnetLink: string | null;
	infohash: string | null;
	status: MediaStatus | null;
	progress: number | null;
	filePath: string | null;
	fileSize: number | null;
	fileIndex: number | null;
	downloadedBytes: number | null;
	playPosition: number | null;
	playDuration: number | null;
	lastPlayedAt: Date | null;
}

export interface Season {
	id: string;
	mediaId: string;
	seasonNumber: number;
	name: string | null;
	episodeCount: number | null;
}

export type SeasonWithEpisodes = Season & {
	episodes: Media[];
};

export interface CatalogSeason {
	seasonNumber: number;
	name: string;
	episodeCount: number;
}
export interface SubtitleTrackResponse {
	id: string;
	mediaId: string;
	language: string;
	label: string;
	source: string;
	src: string;
}
export interface ProgressInfo {
	status: string;
	progress: number;
	downloadSpeed: number;
	peers: number;
	/** Finalization progress from 0 to 1. Zero unless the status is finalizing. */
	transcodeProgress: number;
	fileSize?: number;
}

/** One indexer release a person can pick as a new download source. */
export interface SourceCandidate {
	title: string;
	magnetUri: string;
	infohash: string;
	size: number;
	seeders: number;
	indexer: string;
}

export interface OpenSubtitleResult {
	id: string;
	fileId: number;
	fileName: string;
	language: string;
	languageName: string;
	release: string;
	downloadCount: number;
	hearingImpaired: boolean;
	aiTranslated: boolean;
	fromTrusted: boolean;
	fps: number;
	ratings: number;
}

/** One queued download, plus the episodes that use its files. */
export interface QueueEntry {
	/** Stable queue identity. Download rows and media-only work use separate prefixes. */
	id: string;
	downloadId: string | null;
	downloadInfohash: string | null;
	sourceTitle: string | null;
	media: Media;
	/** Parent show title. Set only when the owner is an episode. */
	showTitle: string | null;
	status: string;
	progress: number;
	/** Live torrent stats. Zero when no torrent is running. */
	downloadSpeed: number;
	peers: number;
	/** Bytes of the selected files. Zero until the torrent's metadata is known. */
	totalSize: number;
	/** Finalization progress from 0 to 1. Zero unless the status is finalizing. */
	transcodeProgress: number;
	episodes: QueueEpisode[];
}

export interface QueueEpisode {
	id: string;
	title: string;
	seasonNumber: number | null;
	episodeNumber: number | null;
	status: MediaStatus | null;
	progress: number;
}
