CREATE TABLE `serp_organic_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`config_id` text NOT NULL,
	`run_id` text NOT NULL,
	`tracking_keyword_id` text NOT NULL,
	`keyword` text NOT NULL,
	`search_engine` text DEFAULT 'google' NOT NULL,
	`location_code` integer NOT NULL,
	`location_name` text,
	`language_code` text NOT NULL,
	`device` text NOT NULL,
	`position` integer NOT NULL,
	`url` text NOT NULL,
	`normalized_url` text NOT NULL,
	`title` text,
	`domain` text,
	`provider` text NOT NULL,
	`coverage_status` text DEFAULT 'full' NOT NULL,
	`observed_at` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`config_id`) REFERENCES `rank_tracking_configs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `rank_check_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `serp_organic_snapshots_project_market_device_idx` ON `serp_organic_snapshots` (`project_id`,`location_code`,`language_code`,`device`);--> statement-breakpoint
CREATE INDEX `serp_organic_snapshots_project_observed_idx` ON `serp_organic_snapshots` (`project_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `serp_organic_snapshots_run_idx` ON `serp_organic_snapshots` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `serp_organic_snapshots_run_keyword_position_idx` ON `serp_organic_snapshots` (`run_id`,`tracking_keyword_id`,`device`,`position`);