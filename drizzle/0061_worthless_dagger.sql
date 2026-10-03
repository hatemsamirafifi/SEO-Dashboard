CREATE TABLE `ga4_project_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`event_name` text NOT NULL,
	`match_key_event_only` integer DEFAULT false NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ga4_goals_project_name_active_uidx` ON `ga4_project_goals` (`project_id`,`name`) WHERE "ga4_project_goals"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX `ga4_goals_project_idx` ON `ga4_project_goals` (`project_id`);