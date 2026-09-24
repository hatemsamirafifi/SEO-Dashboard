CREATE TABLE `opportunities` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`logical_key` text NOT NULL,
	`occurrence_number` integer DEFAULT 1 NOT NULL,
	`type` text NOT NULL,
	`detector_key` text NOT NULL,
	`detector_version` integer NOT NULL,
	`score_version` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`impact_score` integer NOT NULL,
	`confidence_score` integer NOT NULL,
	`priority` text NOT NULL,
	`title` text NOT NULL,
	`explanation_fact` text NOT NULL,
	`recommendation` text NOT NULL,
	`evidence_json` text NOT NULL,
	`keyword` text,
	`page` text,
	`source_metrics_json` text,
	`sources_json` text DEFAULT '[]' NOT NULL,
	`impact_factors_json` text,
	`confidence_inputs_json` text,
	`last_seen_scan_id` text,
	`consecutive_misses` integer DEFAULT 0 NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	`stale_at` text,
	`recurrence_of_id` text,
	`superseded_by_id` text,
	`first_detected_at` text NOT NULL,
	`last_detected_at` text NOT NULL,
	`completed_at` text,
	`dismissed_at` text,
	`dismissal_reason` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opportunities_active_key_uidx` ON `opportunities` (`project_id`,`logical_key`) WHERE "opportunities"."status" IN ('open', 'in_progress');--> statement-breakpoint
CREATE INDEX `opportunities_project_status_idx` ON `opportunities` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `opportunities_project_type_status_idx` ON `opportunities` (`project_id`,`type`,`status`);--> statement-breakpoint
CREATE INDEX `opportunities_project_priority_impact_idx` ON `opportunities` (`project_id`,`priority`,`impact_score`);--> statement-breakpoint
CREATE INDEX `opportunities_project_page_idx` ON `opportunities` (`project_id`,`page`);--> statement-breakpoint
CREATE INDEX `opportunities_project_keyword_idx` ON `opportunities` (`project_id`,`keyword`);--> statement-breakpoint
CREATE INDEX `opportunities_recurrence_of_idx` ON `opportunities` (`recurrence_of_id`);--> statement-breakpoint
CREATE TABLE `opportunity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`occurrence_id` text NOT NULL,
	`type` text NOT NULL,
	`event_key` text NOT NULL,
	`scan_id` text,
	`payload_json` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`occurrence_id`) REFERENCES `opportunities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opportunity_events_occurrence_key_uidx` ON `opportunity_events` (`occurrence_id`,`event_key`);--> statement-breakpoint
CREATE INDEX `opportunity_events_occurrence_created_idx` ON `opportunity_events` (`occurrence_id`,`created_at`);