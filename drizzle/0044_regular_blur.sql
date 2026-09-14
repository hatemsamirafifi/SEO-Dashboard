PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_rank_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text,
	`config_id` text,
	`tracking_keyword_id` text NOT NULL,
	`keyword` text NOT NULL,
	`search_engine` text DEFAULT 'google' NOT NULL,
	`search_type` text DEFAULT 'organic' NOT NULL,
	`location` text,
	`language` text,
	`device` text NOT NULL,
	`position` integer,
	`previous_position` integer,
	`ranking_status` text,
	`url` text,
	`serp_features` text,
	`provider` text DEFAULT 'dataforseo' NOT NULL,
	`provider_status` text,
	`provider_status_code` integer,
	`error_message` text,
	`checked_at` text DEFAULT (current_timestamp) NOT NULL,
	`checked_date` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `rank_check_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`config_id`) REFERENCES `rank_tracking_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_rank_snapshots`("id", "run_id", "project_id", "config_id", "tracking_keyword_id", "keyword", "search_engine", "search_type", "location", "language", "device", "position", "previous_position", "ranking_status", "url", "serp_features", "provider", "provider_status", "provider_status_code", "error_message", "checked_at", "checked_date", "created_at", "updated_at") SELECT "id", "run_id", "project_id", "config_id", "tracking_keyword_id", "keyword", "search_engine", "search_type", "location", "language", "device", "position", "previous_position", "ranking_status", "url", "serp_features", "provider", "provider_status", "provider_status_code", "error_message", "checked_at", "checked_date", "created_at", "updated_at" FROM `rank_snapshots`;--> statement-breakpoint
DROP TABLE `rank_snapshots`;--> statement-breakpoint
ALTER TABLE `__new_rank_snapshots` RENAME TO `rank_snapshots`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `rank_snapshots_keyword_device_idx` ON `rank_snapshots` (`tracking_keyword_id`,`device`,`checked_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `rank_snapshots_run_keyword_device_idx` ON `rank_snapshots` (`run_id`,`tracking_keyword_id`,`device`);--> statement-breakpoint
CREATE INDEX `rank_snapshots_project_kw_checked_idx` ON `rank_snapshots` (`project_id`,`tracking_keyword_id`,`checked_at`);--> statement-breakpoint
CREATE INDEX `rank_snapshots_config_checked_idx` ON `rank_snapshots` (`config_id`,`checked_at`);--> statement-breakpoint
CREATE INDEX `rank_snapshots_project_date_idx` ON `rank_snapshots` (`project_id`,`checked_date`);