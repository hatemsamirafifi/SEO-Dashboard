CREATE TABLE `seo_action_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `seo_action_plans_project_idx` ON `seo_action_plans` (`project_id`);
--> statement-breakpoint
CREATE INDEX `seo_action_plans_org_idx` ON `seo_action_plans` (`organization_id`);
--> statement-breakpoint
CREATE TABLE `seo_action_items` (
	`id` text PRIMARY KEY NOT NULL,
	`action_plan_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`recommendation_fingerprint` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`category` text NOT NULL,
	`priority` text NOT NULL,
	`effort` text,
	`expected_impact` text,
	`evidence_confidence` text,
	`target_keyword` text,
	`target_url` text,
	`recommended_action` text,
	`validation_metric` text,
	`baseline_value` text,
	`baseline_observation_date` text,
	`due_date` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`verification_outcome` text,
	`verification_notes` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	`completed_at` text,
	`verified_at` text,
	FOREIGN KEY (`action_plan_id`) REFERENCES `seo_action_plans`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seo_action_items_plan_idx` ON `seo_action_items` (`action_plan_id`);
--> statement-breakpoint
CREATE INDEX `seo_action_items_project_status_idx` ON `seo_action_items` (`project_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `seo_action_items_fingerprint_idx` ON `seo_action_items` (`project_id`, `recommendation_fingerprint`);
--> statement-breakpoint
CREATE TABLE `seo_action_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`action_item_id` text NOT NULL,
	`source` text NOT NULL,
	`provider` text NOT NULL,
	`source_record_id` text,
	`metric_name` text NOT NULL,
	`metric_value` text NOT NULL,
	`observation_date` text,
	`observation_range` text,
	`target_device` text,
	`target_country` text,
	`target_url` text,
	`metadata` text,
	FOREIGN KEY (`action_item_id`) REFERENCES `seo_action_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seo_action_evidence_item_idx` ON `seo_action_evidence` (`action_item_id`);
--> statement-breakpoint
CREATE TABLE `seo_action_events` (
	`id` text PRIMARY KEY NOT NULL,
	`action_item_id` text NOT NULL,
	`actor` text NOT NULL,
	`previous_status` text,
	`new_status` text NOT NULL,
	`notes` text,
	`metadata` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`action_item_id`) REFERENCES `seo_action_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seo_action_events_item_idx` ON `seo_action_events` (`action_item_id`);
