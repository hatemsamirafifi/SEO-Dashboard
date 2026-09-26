CREATE TABLE `ga4_daily_acquisition` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`property_id` text NOT NULL,
	`ga4_connection_id` text,
	`date` text NOT NULL,
	`channel_group` text NOT NULL,
	`source` text NOT NULL,
	`medium` text NOT NULL,
	`raw_channel_group` text,
	`raw_source` text,
	`raw_medium` text,
	`sessions` integer DEFAULT 0 NOT NULL,
	`engaged_sessions` integer DEFAULT 0 NOT NULL,
	`user_engagement_duration` real DEFAULT 0 NOT NULL,
	`screen_page_views` integer DEFAULT 0 NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`new_users` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ga4_connection_id`) REFERENCES `ga4_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ga4_acquisition_upsert_idx` ON `ga4_daily_acquisition` (`project_id`,`property_id`,`date`,`channel_group`,`source`,`medium`);--> statement-breakpoint
CREATE INDEX `ga4_acquisition_project_date_idx` ON `ga4_daily_acquisition` (`project_id`,`date`);--> statement-breakpoint
CREATE INDEX `ga4_acquisition_project_channel_date_idx` ON `ga4_daily_acquisition` (`project_id`,`channel_group`,`date`);--> statement-breakpoint
CREATE TABLE `ga4_daily_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`property_id` text NOT NULL,
	`ga4_connection_id` text,
	`date` text NOT NULL,
	`event_name` text NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`is_key_event` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ga4_connection_id`) REFERENCES `ga4_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ga4_events_upsert_idx` ON `ga4_daily_events` (`project_id`,`property_id`,`date`,`event_name`);--> statement-breakpoint
CREATE INDEX `ga4_events_project_event_date_idx` ON `ga4_daily_events` (`project_id`,`event_name`,`date`);--> statement-breakpoint
CREATE TABLE `ga4_daily_landing_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`property_id` text NOT NULL,
	`ga4_connection_id` text,
	`date` text NOT NULL,
	`landing_page` text NOT NULL,
	`raw_landing_page` text,
	`sessions` integer DEFAULT 0 NOT NULL,
	`engaged_sessions` integer DEFAULT 0 NOT NULL,
	`user_engagement_duration` real DEFAULT 0 NOT NULL,
	`screen_page_views` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ga4_connection_id`) REFERENCES `ga4_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ga4_landing_upsert_idx` ON `ga4_daily_landing_pages` (`project_id`,`property_id`,`date`,`landing_page`);--> statement-breakpoint
CREATE INDEX `ga4_landing_project_page_date_idx` ON `ga4_daily_landing_pages` (`project_id`,`landing_page`,`date`);--> statement-breakpoint
CREATE TABLE `ga4_daily_summary` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`property_id` text NOT NULL,
	`ga4_connection_id` text,
	`date` text NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`engaged_sessions` integer DEFAULT 0 NOT NULL,
	`user_engagement_duration` real DEFAULT 0 NOT NULL,
	`screen_page_views` integer DEFAULT 0 NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`new_users` integer DEFAULT 0 NOT NULL,
	`total_users` integer DEFAULT 0 NOT NULL,
	`active_users` integer DEFAULT 0 NOT NULL,
	`total_revenue` real DEFAULT 0 NOT NULL,
	`purchase_revenue` real DEFAULT 0 NOT NULL,
	`transactions` integer DEFAULT 0 NOT NULL,
	`add_to_carts` integer DEFAULT 0 NOT NULL,
	`checkouts` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ga4_connection_id`) REFERENCES `ga4_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ga4_summary_upsert_idx` ON `ga4_daily_summary` (`project_id`,`property_id`,`date`);--> statement-breakpoint
CREATE INDEX `ga4_summary_project_date_idx` ON `ga4_daily_summary` (`project_id`,`date`);--> statement-breakpoint
CREATE TABLE `ga4_sync_coverage` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`property_id` text NOT NULL,
	`date` text NOT NULL,
	`grain` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`truncation_meta` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ga4_coverage_upsert_idx` ON `ga4_sync_coverage` (`project_id`,`property_id`,`date`,`grain`);--> statement-breakpoint
CREATE INDEX `ga4_coverage_project_grain_date_idx` ON `ga4_sync_coverage` (`project_id`,`grain`,`date`);--> statement-breakpoint
CREATE TABLE `ga4_syncs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`ga4_connection_id` text,
	`property_id` text NOT NULL,
	`sync_type` text NOT NULL,
	`requested_start_date` text NOT NULL,
	`requested_end_date` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`completed_at` text,
	`rows_fetched` integer DEFAULT 0 NOT NULL,
	`rows_inserted` integer DEFAULT 0 NOT NULL,
	`rows_updated` integer DEFAULT 0 NOT NULL,
	`rows_failed` integer DEFAULT 0 NOT NULL,
	`successful_units` integer DEFAULT 0 NOT NULL,
	`error` text,
	`error_class` text,
	`checkpoint` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ga4_connection_id`) REFERENCES `ga4_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ga4_sync_one_active_per_property_idx` ON `ga4_syncs` (`project_id`,`property_id`) WHERE "ga4_syncs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX `ga4_sync_project_started_idx` ON `ga4_syncs` (`project_id`,`started_at`);--> statement-breakpoint
ALTER TABLE `gsc_search_performance_syncs` ADD `successful_units` integer DEFAULT 0 NOT NULL;