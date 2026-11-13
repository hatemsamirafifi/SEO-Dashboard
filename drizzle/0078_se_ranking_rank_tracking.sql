ALTER TABLE `rank_snapshots` ADD `tracking_target_id` text;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `country_code` text;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `city_name` text;--> statement-breakpoint
DROP INDEX IF EXISTS `rank_snapshots_run_keyword_device_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `rank_snapshots_run_kw_device_loc_lang_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `rank_snapshots_run_target_kw_device_idx` ON `rank_snapshots` (`run_id`,`tracking_target_id`,`tracking_keyword_id`,`device`) WHERE `tracking_target_id` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `rank_snapshots_legacy_run_kw_device_idx` ON `rank_snapshots` (`run_id`,`tracking_keyword_id`,`device`) WHERE `tracking_target_id` IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rank_snapshots_target_checked_idx` ON `rank_snapshots` (`tracking_target_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rank_tracking_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`local_project_id` text NOT NULL,
	`tracking_config_id` text,
	`search_engine` text DEFAULT 'google' NOT NULL,
	`country_code` text NOT NULL,
	`region_code` text,
	`city_name` text,
	`language_code` text DEFAULT 'en' NOT NULL,
	`device` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`local_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracking_config_id`) REFERENCES `rank_tracking_configs`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rank_tracking_targets_project_idx` ON `rank_tracking_targets` (`local_project_id`,`enabled`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rank_tracking_targets_config_idx` ON `rank_tracking_targets` (`tracking_config_id`,`enabled`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `rank_tracking_targets_national_idx` ON `rank_tracking_targets` (`local_project_id`,`search_engine`,`country_code`,`language_code`,`device`) WHERE `city_name` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `rank_tracking_targets_local_idx` ON `rank_tracking_targets` (`local_project_id`,`search_engine`,`country_code`,`city_name`,`language_code`,`device`) WHERE `city_name` IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `rank_tracking_keyword_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`tracking_keyword_id` text NOT NULL,
	`tracking_target_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`tracking_keyword_id`) REFERENCES `rank_tracking_keywords`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracking_target_id`) REFERENCES `rank_tracking_targets`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `rank_tracking_keyword_targets_kw_target_idx` ON `rank_tracking_keyword_targets` (`tracking_keyword_id`,`tracking_target_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `rank_tracking_keyword_targets_target_idx` ON `rank_tracking_keyword_targets` (`tracking_target_id`,`enabled`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `se_ranking_account_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`account_fingerprint` text NOT NULL,
	`credential_version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_validated_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `se_ranking_account_bindings_org_status_idx` ON `se_ranking_account_bindings` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `se_ranking_account_bindings_fingerprint_idx` ON `se_ranking_account_bindings` (`account_fingerprint`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `se_ranking_project_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`local_project_id` text NOT NULL,
	`provider_account_binding_id` text NOT NULL,
	`remote_site_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_successful_sync` text,
	`error_message` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`local_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_account_binding_id`) REFERENCES `se_ranking_account_bindings`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `se_ranking_project_bindings_project_account_idx` ON `se_ranking_project_bindings` (`local_project_id`,`provider_account_binding_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `se_ranking_project_bindings_project_status_idx` ON `se_ranking_project_bindings` (`local_project_id`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `se_ranking_engine_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_binding_id` text NOT NULL,
	`tracking_target_id` text NOT NULL,
	`remote_site_engine_id` integer NOT NULL,
	`remote_search_engine_id` integer NOT NULL,
	`remote_region_id` integer,
	`remote_region_name` text,
	`remote_language_code` text,
	`sync_status` text DEFAULT 'connected' NOT NULL,
	`last_successful_sync` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_binding_id`) REFERENCES `se_ranking_project_bindings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracking_target_id`) REFERENCES `rank_tracking_targets`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `se_ranking_engine_bindings_binding_target_idx` ON `se_ranking_engine_bindings` (`project_binding_id`,`tracking_target_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `se_ranking_engine_bindings_site_engine_idx` ON `se_ranking_engine_bindings` (`project_binding_id`,`remote_site_engine_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `se_ranking_keyword_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_binding_id` text NOT NULL,
	`tracking_keyword_id` text NOT NULL,
	`remote_keyword_id` text NOT NULL,
	`status` text DEFAULT 'synced' NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_binding_id`) REFERENCES `se_ranking_project_bindings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tracking_keyword_id`) REFERENCES `rank_tracking_keywords`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `se_ranking_keyword_mappings_binding_kw_idx` ON `se_ranking_keyword_mappings` (`project_binding_id`,`tracking_keyword_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `se_ranking_keyword_mappings_remote_kw_idx` ON `se_ranking_keyword_mappings` (`project_binding_id`,`remote_keyword_id`);
