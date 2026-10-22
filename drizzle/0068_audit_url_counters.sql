ALTER TABLE `audits` ADD `urls_discovered` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `audits` ADD `urls_fetched` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `audits` ADD `urls_analyzed` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `audits` ADD `urls_blocked` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `audits` ADD `urls_failed` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `audits` ADD `urls_skipped` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `audits` ADD `urls_rendering_required` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `audits` ADD `urls_extraction_complete` integer NOT NULL DEFAULT 0;
