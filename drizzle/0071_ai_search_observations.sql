CREATE TABLE `ai_search_citations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`url` text NOT NULL,
	`domain` text NOT NULL,
	`title` text,
	`position` integer NOT NULL,
	`cited_at` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `ai_search_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_search_citations_run_url_idx` ON `ai_search_citations` (`run_id`,`url`);--> statement-breakpoint
CREATE INDEX `ai_search_citations_project_cited_idx` ON `ai_search_citations` (`project_id`,`cited_at`);--> statement-breakpoint
CREATE TABLE `ai_search_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`model_name` text,
	`prompt_hash` text NOT NULL,
	`prompt_length` integer NOT NULL,
	`web_search` integer NOT NULL,
	`country_code` text,
	`output_tokens` integer,
	`fan_out_count` integer DEFAULT 0 NOT NULL,
	`citation_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'success' NOT NULL,
	`event_key` text NOT NULL,
	`observed_at` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_search_runs_project_observed_idx` ON `ai_search_runs` (`project_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `ai_search_runs_project_model_idx` ON `ai_search_runs` (`project_id`,`model`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_search_runs_event_model_idx` ON `ai_search_runs` (`project_id`,`event_key`,`model`);