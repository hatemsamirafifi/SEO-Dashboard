ALTER TABLE `audit_pages` ADD `extraction_state` text DEFAULT 'NOT_EXTRACTED' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `failure_reason` text;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `html_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `structured_data_json` text;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `platform` text;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `platform_confidence` real;--> statement-breakpoint
UPDATE `audit_pages` SET `extraction_state` = CASE
  WHEN `fetch_class` = 'blocked' THEN 'ACCESS_BLOCKED'
  WHEN `fetch_class` = 'error' THEN 'EXTRACTION_FAILED'
  WHEN `fetch_class` = 'ok' THEN 'STATIC_COMPLETE'
  ELSE 'NOT_EXTRACTED'
END
WHERE `extraction_state` = 'NOT_EXTRACTED';