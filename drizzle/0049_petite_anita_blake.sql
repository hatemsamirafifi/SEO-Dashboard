ALTER TABLE `rank_provider_calls` ADD `attempt` integer;--> statement-breakpoint
ALTER TABLE `rank_provider_calls` ADD `max_retries` integer;--> statement-breakpoint
ALTER TABLE `rank_provider_calls` ADD `retryable` integer;--> statement-breakpoint
ALTER TABLE `rank_provider_calls` ADD `retry_after_ms` integer;--> statement-breakpoint
ALTER TABLE `seo_provider_settings` ADD `max_retries` integer DEFAULT 2 NOT NULL;