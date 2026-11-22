ALTER TABLE `rank_snapshots` ADD `completion_confidence` text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `se_ranking_recheck_dispatch` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`config_id` text NOT NULL,
	`dispatch_scope` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`dispatched_at` integer,
	`outcome_at` integer,
	`provider_response` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `rank_check_runs`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `se_ranking_recheck_dispatch_run_idx` ON `se_ranking_recheck_dispatch` (`run_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `se_ranking_recheck_dispatch_config_idx` ON `se_ranking_recheck_dispatch` (`config_id`);
