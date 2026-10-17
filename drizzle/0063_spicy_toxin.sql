CREATE TABLE `competitor_gap_verdicts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`verdict` text NOT NULL,
	`evidence` text NOT NULL,
	`thresholds` text NOT NULL,
	`input_manifest` text NOT NULL,
	`recorded_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `competitor_gap_verdicts_latest_idx` ON `competitor_gap_verdicts` (`organization_id`,`project_id`,`recorded_at`);