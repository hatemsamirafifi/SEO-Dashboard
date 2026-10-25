CREATE TABLE `google_ads_planner_group_months` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`year` integer NOT NULL,
	`month` integer NOT NULL,
	`volume` integer,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `google_ads_planner_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_planner_group_months_group_month_idx` ON `google_ads_planner_group_months` (`group_id`,`year`,`month`);--> statement-breakpoint
CREATE INDEX `google_ads_planner_group_months_group_idx` ON `google_ads_planner_group_months` (`group_id`);--> statement-breakpoint
CREATE TABLE `google_ads_planner_group_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`variant_keyword` text NOT NULL,
	`source_fetched_at` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `google_ads_planner_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_planner_group_variants_group_variant_idx` ON `google_ads_planner_group_variants` (`group_id`,`variant_keyword`);--> statement-breakpoint
CREATE INDEX `google_ads_planner_group_variants_variant_idx` ON `google_ads_planner_group_variants` (`variant_keyword`);--> statement-breakpoint
CREATE TABLE `google_ads_planner_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`login_customer_id` text,
	`currency_code` text,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`network` text NOT NULL,
	`contract_version` text NOT NULL,
	`keyword` text NOT NULL,
	`avg_monthly_searches` integer,
	`competition` text,
	`competition_index` integer,
	`average_cpc_micros` integer,
	`low_top_of_page_bid_micros` integer,
	`high_top_of_page_bid_micros` integer,
	`source_fetched_at` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_planner_groups_scope_keyword_idx` ON `google_ads_planner_groups` (`project_id`,`customer_id`,`location_code`,`language_code`,`network`,`contract_version`,`keyword`);--> statement-breakpoint
CREATE INDEX `google_ads_planner_groups_organization_idx` ON `google_ads_planner_groups` (`organization_id`);--> statement-breakpoint
CREATE INDEX `google_ads_planner_groups_keyword_idx` ON `google_ads_planner_groups` (`project_id`,`customer_id`,`keyword`);--> statement-breakpoint
CREATE TABLE `google_ads_planner_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`login_customer_id` text,
	`data_type` text NOT NULL,
	`currency_code` text,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`network` text NOT NULL,
	`contract_version` text NOT NULL,
	`seed_keyword` text DEFAULT '' NOT NULL,
	`source_fetched_at` text NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`partial` integer DEFAULT false NOT NULL,
	`malformed_keyword_count` integer DEFAULT 0 NOT NULL,
	`duplicate_keyword_count` integer DEFAULT 0 NOT NULL,
	`missing_keyword_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_ads_planner_observations_scope_idx` ON `google_ads_planner_observations` (`project_id`,`customer_id`,`data_type`,`seed_keyword`,`location_code`,`language_code`,`network`,`contract_version`);--> statement-breakpoint
CREATE INDEX `google_ads_planner_observations_organization_idx` ON `google_ads_planner_observations` (`organization_id`);