CREATE TABLE `dashboard_insights` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`insight_key` text NOT NULL,
	`composer_key` text DEFAULT 'dashboard' NOT NULL,
	`type` text NOT NULL,
	`detector_key` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`explanation_fact` text NOT NULL,
	`recommendation` text,
	`evidence_summary` text NOT NULL,
	`entity_refs_json` text DEFAULT '[]' NOT NULL,
	`periods_from` text,
	`periods_to` text,
	`sources_json` text DEFAULT '[]' NOT NULL,
	`finding_keys_json` text DEFAULT '[]' NOT NULL,
	`opportunity_ids_json` text DEFAULT '[]' NOT NULL,
	`metrics_json` text,
	`content_version` integer DEFAULT 1 NOT NULL,
	`content_hash` text NOT NULL,
	`scan_id` text NOT NULL,
	`detected_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`resolved_at` text,
	`resolve_reason` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dashboard_insights_project_key_uidx` ON `dashboard_insights` (`project_id`,`insight_key`);--> statement-breakpoint
CREATE INDEX `dashboard_insights_project_resolved_idx` ON `dashboard_insights` (`project_id`,`resolved_at`);--> statement-breakpoint
CREATE INDEX `dashboard_insights_project_severity_idx` ON `dashboard_insights` (`project_id`,`severity`);--> statement-breakpoint
CREATE INDEX `dashboard_insights_project_type_idx` ON `dashboard_insights` (`project_id`,`type`);--> statement-breakpoint
CREATE TABLE `insight_user_preferences` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`insight_key` text NOT NULL,
	`dismissed_content_version` integer DEFAULT 0 NOT NULL,
	`snoozed_until` text,
	`hash` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	PRIMARY KEY(`user_id`, `project_id`, `insight_key`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `insight_user_preferences_project_key_idx` ON `insight_user_preferences` (`project_id`,`insight_key`);