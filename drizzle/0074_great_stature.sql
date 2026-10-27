CREATE TABLE `google_ads_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`descriptive_name` text,
	`currency_code` text,
	`time_zone` text,
	`is_test_account` integer DEFAULT false NOT NULL,
	`source_fetched_at` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_accounts_project_customer_idx` ON `google_ads_accounts` (`project_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `google_ads_accounts_organization_idx` ON `google_ads_accounts` (`organization_id`);--> statement-breakpoint
CREATE TABLE `google_ads_ad_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`ad_group_resource_id` text NOT NULL,
	`campaign_resource_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`source_fetched_at` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_ad_groups_resource_idx` ON `google_ads_ad_groups` (`project_id`,`customer_id`,`ad_group_resource_id`);--> statement-breakpoint
CREATE INDEX `google_ads_ad_groups_campaign_idx` ON `google_ads_ad_groups` (`project_id`,`customer_id`,`campaign_resource_id`);--> statement-breakpoint
CREATE TABLE `google_ads_analytics_units` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`date` text NOT NULL,
	`grain` text NOT NULL,
	`published_generation_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error_class` text,
	`row_count` integer DEFAULT 0 NOT NULL,
	`source_fetched_at` text,
	`currency_code` text,
	`metric_date_basis` text,
	`staged_at` text,
	`published_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_analytics_units_unit_idx` ON `google_ads_analytics_units` (`project_id`,`customer_id`,`date`,`grain`);--> statement-breakpoint
CREATE INDEX `google_ads_analytics_units_grain_status_date_idx` ON `google_ads_analytics_units` (`project_id`,`grain`,`status`,`date`);--> statement-breakpoint
CREATE TABLE `google_ads_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`campaign_resource_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`serving_status` text,
	`advertising_channel_type` text,
	`source_fetched_at` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_campaigns_resource_idx` ON `google_ads_campaigns` (`project_id`,`customer_id`,`campaign_resource_id`);--> statement-breakpoint
CREATE INDEX `google_ads_campaigns_organization_idx` ON `google_ads_campaigns` (`organization_id`);--> statement-breakpoint
CREATE TABLE `google_ads_daily_account` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`date` text NOT NULL,
	`generation_id` text NOT NULL,
	`impressions` integer,
	`clicks` integer,
	`cost_micros` integer,
	`conversions` real,
	`conversions_value` real,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_daily_account_generation_idx` ON `google_ads_daily_account` (`project_id`,`customer_id`,`date`,`generation_id`);--> statement-breakpoint
CREATE INDEX `google_ads_daily_account_date_idx` ON `google_ads_daily_account` (`project_id`,`customer_id`,`date`);--> statement-breakpoint
CREATE TABLE `google_ads_daily_ad_group` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`date` text NOT NULL,
	`generation_id` text NOT NULL,
	`campaign_resource_id` text NOT NULL,
	`ad_group_resource_id` text NOT NULL,
	`impressions` integer,
	`clicks` integer,
	`cost_micros` integer,
	`conversions` real,
	`conversions_value` real,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_daily_ad_group_generation_idx` ON `google_ads_daily_ad_group` (`project_id`,`customer_id`,`date`,`ad_group_resource_id`,`generation_id`);--> statement-breakpoint
CREATE INDEX `google_ads_daily_ad_group_date_idx` ON `google_ads_daily_ad_group` (`project_id`,`customer_id`,`date`);--> statement-breakpoint
CREATE TABLE `google_ads_daily_campaign` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`date` text NOT NULL,
	`generation_id` text NOT NULL,
	`campaign_resource_id` text NOT NULL,
	`impressions` integer,
	`clicks` integer,
	`cost_micros` integer,
	`conversions` real,
	`conversions_value` real,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_daily_campaign_generation_idx` ON `google_ads_daily_campaign` (`project_id`,`customer_id`,`date`,`campaign_resource_id`,`generation_id`);--> statement-breakpoint
CREATE INDEX `google_ads_daily_campaign_date_idx` ON `google_ads_daily_campaign` (`project_id`,`customer_id`,`date`);--> statement-breakpoint
CREATE INDEX `google_ads_daily_campaign_resource_date_idx` ON `google_ads_daily_campaign` (`project_id`,`customer_id`,`campaign_resource_id`,`date`);--> statement-breakpoint
CREATE TABLE `google_ads_daily_device` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`date` text NOT NULL,
	`generation_id` text NOT NULL,
	`campaign_resource_id` text NOT NULL,
	`device` text NOT NULL,
	`impressions` integer,
	`clicks` integer,
	`cost_micros` integer,
	`conversions` real,
	`conversions_value` real,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_daily_device_generation_idx` ON `google_ads_daily_device` (`project_id`,`customer_id`,`date`,`campaign_resource_id`,`device`,`generation_id`);--> statement-breakpoint
CREATE INDEX `google_ads_daily_device_date_idx` ON `google_ads_daily_device` (`project_id`,`customer_id`,`date`);--> statement-breakpoint
CREATE TABLE `google_ads_daily_keyword` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`date` text NOT NULL,
	`generation_id` text NOT NULL,
	`campaign_resource_id` text NOT NULL,
	`ad_group_resource_id` text NOT NULL,
	`keyword_resource_id` text NOT NULL,
	`impressions` integer,
	`clicks` integer,
	`cost_micros` integer,
	`conversions` real,
	`conversions_value` real,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_daily_keyword_generation_idx` ON `google_ads_daily_keyword` (`project_id`,`customer_id`,`date`,`keyword_resource_id`,`generation_id`);--> statement-breakpoint
CREATE INDEX `google_ads_daily_keyword_date_idx` ON `google_ads_daily_keyword` (`project_id`,`customer_id`,`date`);--> statement-breakpoint
CREATE TABLE `google_ads_daily_landing_page` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`date` text NOT NULL,
	`generation_id` text NOT NULL,
	`campaign_resource_id` text NOT NULL,
	`landing_page_url` text NOT NULL,
	`impressions` integer,
	`clicks` integer,
	`cost_micros` integer,
	`conversions` real,
	`conversions_value` real,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_daily_landing_page_generation_idx` ON `google_ads_daily_landing_page` (`project_id`,`customer_id`,`date`,`campaign_resource_id`,`landing_page_url`,`generation_id`);--> statement-breakpoint
CREATE INDEX `google_ads_daily_landing_page_date_idx` ON `google_ads_daily_landing_page` (`project_id`,`customer_id`,`date`);--> statement-breakpoint
CREATE TABLE `google_ads_daily_search_term` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`date` text NOT NULL,
	`generation_id` text NOT NULL,
	`campaign_resource_id` text NOT NULL,
	`ad_group_resource_id` text NOT NULL,
	`search_text` text NOT NULL,
	`keyword_text` text,
	`keyword_match_type` text,
	`impressions` integer,
	`clicks` integer,
	`cost_micros` integer,
	`conversions` real,
	`conversions_value` real,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_daily_search_term_generation_idx` ON `google_ads_daily_search_term` (`project_id`,`customer_id`,`date`,`campaign_resource_id`,`ad_group_resource_id`,`search_text`,`generation_id`);--> statement-breakpoint
CREATE INDEX `google_ads_daily_search_term_date_idx` ON `google_ads_daily_search_term` (`project_id`,`customer_id`,`date`);--> statement-breakpoint
CREATE TABLE `google_ads_keywords` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`keyword_resource_id` text NOT NULL,
	`campaign_resource_id` text NOT NULL,
	`ad_group_resource_id` text NOT NULL,
	`keyword_text` text NOT NULL,
	`keyword_match_type` text,
	`source_fetched_at` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_keywords_resource_idx` ON `google_ads_keywords` (`project_id`,`customer_id`,`keyword_resource_id`);--> statement-breakpoint
CREATE INDEX `google_ads_keywords_ad_group_idx` ON `google_ads_keywords` (`project_id`,`customer_id`,`ad_group_resource_id`);--> statement-breakpoint
CREATE TABLE `google_ads_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`run_key` text NOT NULL,
	`mode` text NOT NULL,
	`window_start_date` text NOT NULL,
	`window_end_date` text NOT NULL,
	`scheduled_slot` text,
	`fingerprint_grant_account_id` text NOT NULL,
	`fingerprint_connection_id` text NOT NULL,
	`fingerprint_login_customer_id` text,
	`fingerprint_connection_updated_at` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`lease_expires_at` text NOT NULL,
	`heartbeat_at` text,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`completed_at` text,
	`units_total` integer DEFAULT 0 NOT NULL,
	`units_succeeded` integer DEFAULT 0 NOT NULL,
	`units_failed` integer DEFAULT 0 NOT NULL,
	`error_class` text,
	`error_message` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_sync_runs_active_claim_idx` ON `google_ads_sync_runs` (`project_id`,`customer_id`,`run_key`) WHERE "google_ads_sync_runs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX `google_ads_sync_runs_project_created_idx` ON `google_ads_sync_runs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `google_ads_sync_runs_scope_status_idx` ON `google_ads_sync_runs` (`project_id`,`customer_id`,`status`);--> statement-breakpoint
CREATE TABLE `google_ads_sync_units` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`run_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`date` text NOT NULL,
	`grain` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`error_class` text,
	`error_message` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `google_ads_sync_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_sync_units_unique_idx` ON `google_ads_sync_units` (`run_id`,`date`,`grain`);--> statement-breakpoint
CREATE INDEX `google_ads_sync_units_replay_idx` ON `google_ads_sync_units` (`project_id`,`customer_id`,`grain`,`status`);--> statement-breakpoint
CREATE INDEX `google_ads_sync_units_run_status_idx` ON `google_ads_sync_units` (`run_id`,`status`);