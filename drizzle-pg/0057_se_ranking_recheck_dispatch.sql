ALTER TABLE "rank_snapshots" ADD COLUMN IF NOT EXISTS "completion_confidence" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "se_ranking_recheck_dispatch" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"config_id" text NOT NULL,
	"dispatch_scope" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"dispatched_at" bigint,
	"outcome_at" bigint,
	"provider_response" text,
	"created_at" bigint NOT NULL
);--> statement-breakpoint
ALTER TABLE "se_ranking_recheck_dispatch" ADD CONSTRAINT "se_ranking_recheck_dispatch_run_id_rank_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."rank_check_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "se_ranking_recheck_dispatch_run_idx" ON "se_ranking_recheck_dispatch" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "se_ranking_recheck_dispatch_config_idx" ON "se_ranking_recheck_dispatch" USING btree ("config_id");
