CREATE TABLE "rank_provider_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"tracking_keyword_id" text NOT NULL,
	"device" text NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"error_code" text,
	"duration_ms" integer NOT NULL,
	"result_count" integer,
	"inspected_depth" integer,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seo_provider_settings" ADD COLUMN "priority" integer;--> statement-breakpoint
ALTER TABLE "rank_provider_calls" ADD CONSTRAINT "rank_provider_calls_run_id_rank_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."rank_check_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rank_provider_calls_run_idx" ON "rank_provider_calls" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "rank_provider_calls_keyword_idx" ON "rank_provider_calls" USING btree ("run_id","tracking_keyword_id","device");