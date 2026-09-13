ALTER TABLE "rank_snapshots" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "config_id" text;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "search_engine" text DEFAULT 'google' NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "search_type" text DEFAULT 'organic' NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "location" text;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "previous_position" integer;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "ranking_status" text;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "provider" text DEFAULT 'dataforseo' NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "provider_status_code" integer;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "checked_date" text;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD CONSTRAINT "rank_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD CONSTRAINT "rank_snapshots_config_id_rank_tracking_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."rank_tracking_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rank_snapshots_project_kw_checked_idx" ON "rank_snapshots" USING btree ("project_id","tracking_keyword_id","checked_at");--> statement-breakpoint
CREATE INDEX "rank_snapshots_config_checked_idx" ON "rank_snapshots" USING btree ("config_id","checked_at");--> statement-breakpoint
CREATE INDEX "rank_snapshots_project_date_idx" ON "rank_snapshots" USING btree ("project_id","checked_date");--> statement-breakpoint
UPDATE "rank_snapshots"
SET
  "project_id" = (SELECT "project_id" FROM "rank_check_runs" WHERE "rank_check_runs"."id" = "rank_snapshots"."run_id"),
  "config_id" = (SELECT "config_id" FROM "rank_check_runs" WHERE "rank_check_runs"."id" = "rank_snapshots"."run_id"),
  "checked_date" = SUBSTR("checked_at", 1, 10),
  "ranking_status" = CASE WHEN "position" IS NOT NULL THEN 'RANKED' ELSE NULL END,
  "created_at" = "checked_at",
  "updated_at" = "checked_at"
WHERE "project_id" IS NULL;