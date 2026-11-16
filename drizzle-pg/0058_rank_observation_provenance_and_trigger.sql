ALTER TABLE "rank_check_runs" ADD COLUMN IF NOT EXISTS "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN IF NOT EXISTS "observation_source" text;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN IF NOT EXISTS "imported_at" text;--> statement-breakpoint
DROP INDEX IF EXISTS "rank_snapshots_run_target_kw_device_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rank_snapshots_run_target_kw_device_idx" ON "rank_snapshots" USING btree ("run_id","tracking_target_id","tracking_keyword_id","device","checked_date") WHERE tracking_target_id IS NOT NULL;
