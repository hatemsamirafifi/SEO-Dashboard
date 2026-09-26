CREATE TABLE `rank_provider_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`tracking_keyword_id` text NOT NULL,
	`device` text NOT NULL,
	`provider` text NOT NULL,
	`endpoint` text NOT NULL,
	`status` text NOT NULL,
	`http_status` integer,
	`error_code` text,
	`duration_ms` integer NOT NULL,
	`result_count` integer,
	`inspected_depth` integer,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `rank_check_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rank_provider_calls_run_idx` ON `rank_provider_calls` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `rank_provider_calls_keyword_idx` ON `rank_provider_calls` (`run_id`,`tracking_keyword_id`,`device`);--> statement-breakpoint
ALTER TABLE `seo_provider_settings` ADD `priority` integer;