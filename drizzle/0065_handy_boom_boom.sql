CREATE TABLE `salla_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`connected_by_user_id` text NOT NULL,
	`merchant_id` text NOT NULL,
	`merchant_name` text,
	`store_id` text NOT NULL,
	`store_domain` text,
	`store_url` text,
	`store_status` text,
	`scope` text,
	`token_ciphertext` text NOT NULL,
	`token_expires_at` text,
	`connected_at` text DEFAULT (current_timestamp) NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `salla_connections_project_idx` ON `salla_connections` (`project_id`);--> statement-breakpoint
CREATE INDEX `salla_connections_organization_idx` ON `salla_connections` (`organization_id`);