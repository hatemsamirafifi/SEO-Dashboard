ALTER TABLE `rank_provider_calls` ADD `requested_depth` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rank_provider_calls` ADD `pages_requested` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rank_provider_calls` ADD `result_completeness` text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE `rank_provider_calls` ADD `dispatched` integer DEFAULT true NOT NULL;
