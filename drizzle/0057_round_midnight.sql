CREATE TABLE `organization_branding` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`agency_name` text DEFAULT '' NOT NULL,
	`agency_logo_r2_key` text,
	`accent_color` text,
	`footer_text` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `project_client_profiles` (
	`project_id` text PRIMARY KEY NOT NULL,
	`client_name` text DEFAULT '' NOT NULL,
	`client_logo_r2_key` text,
	`report_title_override` text,
	`notes` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `report_events` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`organization_id` text,
	`type` text NOT NULL,
	`user_id` text,
	`metadata_json` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `report_events_report_idx` ON `report_events` (`report_id`);--> statement-breakpoint
CREATE TABLE `report_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_user_id` text,
	`expires_at` text,
	`revoked_at` text,
	`view_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_shares_token_hash_unique` ON `report_shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `report_shares_report_idx` ON `report_shares` (`report_id`);--> statement-breakpoint
ALTER TABLE `reports` ADD `branding_snapshot_json` text;