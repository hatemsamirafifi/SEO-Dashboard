ALTER TABLE `rank_snapshots` ADD `project_id` text REFERENCES projects(id);--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `config_id` text REFERENCES rank_tracking_configs(id);--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `search_engine` text DEFAULT 'google' NOT NULL;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `search_type` text DEFAULT 'organic' NOT NULL;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `location` text;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `language` text;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `previous_position` integer;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `ranking_status` text;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `provider` text DEFAULT 'dataforseo' NOT NULL;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `provider_status` text;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `provider_status_code` integer;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `error_message` text;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `checked_date` text;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `created_at` text;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `updated_at` text;--> statement-breakpoint
CREATE INDEX `rank_snapshots_project_kw_checked_idx` ON `rank_snapshots` (`project_id`,`tracking_keyword_id`,`checked_at`);--> statement-breakpoint
CREATE INDEX `rank_snapshots_config_checked_idx` ON `rank_snapshots` (`config_id`,`checked_at`);--> statement-breakpoint
CREATE INDEX `rank_snapshots_project_date_idx` ON `rank_snapshots` (`project_id`,`checked_date`);--> statement-breakpoint
UPDATE `rank_snapshots`
SET
  `project_id` = (SELECT `project_id` FROM `rank_check_runs` WHERE `rank_check_runs`.`id` = `rank_snapshots`.`run_id`),
  `config_id` = (SELECT `config_id` FROM `rank_check_runs` WHERE `rank_check_runs`.`id` = `rank_snapshots`.`run_id`),
  `checked_date` = SUBSTR(`checked_at`, 1, 10),
  `ranking_status` = CASE WHEN `position` IS NOT NULL THEN 'RANKED' ELSE NULL END,
  `created_at` = `checked_at`,
  `updated_at` = `checked_at`
WHERE `project_id` IS NULL;