CREATE TABLE `intelligence_run_detectors` (
	`run_id` text NOT NULL,
	`detector_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`findings_count` integer DEFAULT 0 NOT NULL,
	`chunk_keys_json` text,
	`skip_reason` text,
	`error` text,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`completed_at` text,
	PRIMARY KEY(`run_id`, `detector_key`),
	FOREIGN KEY (`run_id`) REFERENCES `intelligence_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `intelligence_run_detectors_run_idx` ON `intelligence_run_detectors` (`run_id`);--> statement-breakpoint
CREATE TABLE `intelligence_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_stage` text DEFAULT 'pending' NOT NULL,
	`input_hash` text,
	`input_source_versions_json` text,
	`detector_versions_json` text,
	`threshold_version` integer,
	`manifest_key` text,
	`manifest_hash` text,
	`findings_schema_version` integer,
	`findings_count` integer DEFAULT 0 NOT NULL,
	`detection_attempt_meta_json` text,
	`stage_state_json` text,
	`error` text,
	`error_class` text,
	`error_stage` text,
	`triggered_by` text DEFAULT 'cron' NOT NULL,
	`started_at` text DEFAULT (current_timestamp) NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `intelligence_runs_project_started_idx` ON `intelligence_runs` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `intelligence_runs_project_status_idx` ON `intelligence_runs` (`project_id`,`status`);