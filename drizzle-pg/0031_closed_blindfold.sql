CREATE TABLE "intelligence_run_detectors" (
	"run_id" text NOT NULL,
	"detector_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"findings_count" integer DEFAULT 0 NOT NULL,
	"chunk_keys_json" text,
	"skip_reason" text,
	"error" text,
	"started_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"completed_at" text,
	CONSTRAINT "intelligence_run_detectors_run_id_detector_key_pk" PRIMARY KEY("run_id","detector_key")
);
--> statement-breakpoint
CREATE TABLE "intelligence_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_stage" text DEFAULT 'pending' NOT NULL,
	"input_hash" text,
	"input_source_versions_json" text,
	"detector_versions_json" text,
	"threshold_version" integer,
	"manifest_key" text,
	"manifest_hash" text,
	"findings_schema_version" integer,
	"findings_count" integer DEFAULT 0 NOT NULL,
	"detection_attempt_meta_json" text,
	"stage_state_json" text,
	"error" text,
	"error_class" text,
	"error_stage" text,
	"triggered_by" text DEFAULT 'cron' NOT NULL,
	"started_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"completed_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "intelligence_run_detectors" ADD CONSTRAINT "intelligence_run_detectors_run_id_intelligence_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."intelligence_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_runs" ADD CONSTRAINT "intelligence_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intelligence_runs" ADD CONSTRAINT "intelligence_runs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intelligence_run_detectors_run_idx" ON "intelligence_run_detectors" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "intelligence_runs_project_started_idx" ON "intelligence_runs" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE INDEX "intelligence_runs_project_status_idx" ON "intelligence_runs" USING btree ("project_id","status");