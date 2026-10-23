CREATE TABLE "serp_organic_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"config_id" text NOT NULL,
	"run_id" text NOT NULL,
	"tracking_keyword_id" text NOT NULL,
	"keyword" text NOT NULL,
	"search_engine" text DEFAULT 'google' NOT NULL,
	"location_code" integer NOT NULL,
	"location_name" text,
	"language_code" text NOT NULL,
	"device" text NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"title" text,
	"domain" text,
	"provider" text NOT NULL,
	"coverage_status" text DEFAULT 'full' NOT NULL,
	"observed_at" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "serp_organic_snapshots" ADD CONSTRAINT "serp_organic_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_organic_snapshots" ADD CONSTRAINT "serp_organic_snapshots_config_id_rank_tracking_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."rank_tracking_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_organic_snapshots" ADD CONSTRAINT "serp_organic_snapshots_run_id_rank_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."rank_check_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "serp_organic_snapshots_project_market_device_idx" ON "serp_organic_snapshots" USING btree ("project_id","location_code","language_code","device");--> statement-breakpoint
CREATE INDEX "serp_organic_snapshots_project_observed_idx" ON "serp_organic_snapshots" USING btree ("project_id","observed_at");--> statement-breakpoint
CREATE INDEX "serp_organic_snapshots_run_idx" ON "serp_organic_snapshots" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "serp_organic_snapshots_run_keyword_position_idx" ON "serp_organic_snapshots" USING btree ("run_id","tracking_keyword_id","device","position");