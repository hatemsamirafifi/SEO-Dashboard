ALTER TABLE "audits" ADD COLUMN "urls_discovered" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "urls_fetched" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "urls_analyzed" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "urls_blocked" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "urls_failed" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "urls_skipped" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "urls_rendering_required" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "urls_extraction_complete" integer NOT NULL DEFAULT 0;
