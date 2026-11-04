ALTER TABLE `configuration` ADD `video_encoder` text DEFAULT 'auto';--> statement-breakpoint
ALTER TABLE `configuration` ADD `torrent_engine` text DEFAULT 'webtorrent';--> statement-breakpoint
ALTER TABLE `configuration` ADD `rqbit_url` text;