CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`type` text NOT NULL,
	`period_from` text NOT NULL,
	`period_to` text NOT NULL,
	`payload_snapshot_json` text NOT NULL,
	`consistency_status` text NOT NULL,
	`intelligence_run_id` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reports_project_created_idx` ON `reports` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `reports_project_type_idx` ON `reports` (`project_id`,`type`);