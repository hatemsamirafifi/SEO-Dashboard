CREATE TABLE `report_schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`scheduled_for` text NOT NULL,
	`report_id` text,
	`state` text NOT NULL,
	`failure_class` text,
	`skip_reason` text,
	`recipient_outcomes` text,
	`claimed_at` text NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`schedule_id`) REFERENCES `report_schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_schedule_runs_unique_schedule_for_idx` ON `report_schedule_runs` (`schedule_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `report_schedule_runs_schedule_idx` ON `report_schedule_runs` (`schedule_id`,`scheduled_for`);--> statement-breakpoint
CREATE TABLE `report_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`report_type` text NOT NULL,
	`cadence` text NOT NULL,
	`recipients` text NOT NULL,
	`share_id` text,
	`active` integer DEFAULT true NOT NULL,
	`paused_at` text,
	`next_due_at` text NOT NULL,
	`last_run_at` text,
	`created_by_user_id` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `report_schedules_project_idx` ON `report_schedules` (`project_id`);--> statement-breakpoint
CREATE INDEX `report_schedules_due_idx` ON `report_schedules` (`active`,`next_due_at`);