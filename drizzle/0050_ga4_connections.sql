CREATE TABLE `ga4_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`property_id` text NOT NULL,
	`property_display_name` text NOT NULL,
	`connected_by_user_id` text NOT NULL,
	`ga4_account_id` text NOT NULL,
	`currency_code` text,
	`has_ecommerce` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ga4_connections_project_idx` ON `ga4_connections` (`project_id`);--> statement-breakpoint
CREATE INDEX `ga4_connections_organization_idx` ON `ga4_connections` (`organization_id`);
