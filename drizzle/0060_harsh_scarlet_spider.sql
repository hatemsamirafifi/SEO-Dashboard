CREATE TABLE `ga4_daily_geo` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`property_id` text NOT NULL,
	`ga4_connection_id` text,
	`date` text NOT NULL,
	`country` text NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`engaged_sessions` integer DEFAULT 0 NOT NULL,
	`user_engagement_duration` real DEFAULT 0 NOT NULL,
	`screen_page_views` integer DEFAULT 0 NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`new_users` integer DEFAULT 0 NOT NULL,
	`is_other_row` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ga4_connection_id`) REFERENCES `ga4_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ga4_geo_upsert_idx` ON `ga4_daily_geo` (`project_id`,`property_id`,`date`,`country`);--> statement-breakpoint
CREATE INDEX `ga4_geo_project_date_idx` ON `ga4_daily_geo` (`project_id`,`date`);--> statement-breakpoint
CREATE INDEX `ga4_geo_project_country_date_idx` ON `ga4_daily_geo` (`project_id`,`country`,`date`);--> statement-breakpoint
CREATE TABLE `ga4_daily_technology` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`property_id` text NOT NULL,
	`ga4_connection_id` text,
	`date` text NOT NULL,
	`device` text NOT NULL,
	`browser` text NOT NULL,
	`os` text NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`engaged_sessions` integer DEFAULT 0 NOT NULL,
	`user_engagement_duration` real DEFAULT 0 NOT NULL,
	`screen_page_views` integer DEFAULT 0 NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`new_users` integer DEFAULT 0 NOT NULL,
	`is_other_row` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ga4_connection_id`) REFERENCES `ga4_connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ga4_technology_upsert_idx` ON `ga4_daily_technology` (`project_id`,`property_id`,`date`,`device`,`browser`,`os`);--> statement-breakpoint
CREATE INDEX `ga4_technology_project_date_idx` ON `ga4_daily_technology` (`project_id`,`date`);--> statement-breakpoint
CREATE INDEX `ga4_technology_project_device_date_idx` ON `ga4_daily_technology` (`project_id`,`device`,`date`);