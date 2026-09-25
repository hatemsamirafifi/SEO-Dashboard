CREATE TABLE "autopilot_run_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"source_versions_json" text NOT NULL,
	"source_versions_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invalidation_reason" text,
	"superseded_by_attempt_id" text,
	"started_at" text,
	"completed_at" text,
	"created_at" text DEFAULT (current_timestamp) NOT NULL,
	"updated_at" text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autopilot_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"workflow_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_attempt_id" text,
	"evidence_hash" text,
	"started_by_user_id" text,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"error" text,
	"error_class" text,
	"started_at" text,
	"completed_at" text,
	"created_at" text DEFAULT (current_timestamp) NOT NULL,
	"updated_at" text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autopilot_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_id" text NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"evidence_json" text,
	"evidence_hash" text,
	"effective_source_versions_json" text,
	"collection_attempts" integer DEFAULT 0 NOT NULL,
	"reused_from_attempt" text,
	"idempotency_key" text,
	"error" text,
	"created_at" text DEFAULT (current_timestamp) NOT NULL,
	"updated_at" text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "autopilot_run_attempts" ADD CONSTRAINT "autopilot_run_attempts_run_id_autopilot_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."autopilot_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_runs" ADD CONSTRAINT "autopilot_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_steps" ADD CONSTRAINT "autopilot_steps_attempt_id_autopilot_run_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."autopilot_run_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_steps" ADD CONSTRAINT "autopilot_steps_run_id_autopilot_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."autopilot_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "autopilot_attempts_run_number_uidx" ON "autopilot_run_attempts" USING btree ("run_id","attempt_number");--> statement-breakpoint
CREATE INDEX "autopilot_attempts_run_idx" ON "autopilot_run_attempts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "autopilot_runs_project_status_idx" ON "autopilot_runs" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "autopilot_runs_project_started_idx" ON "autopilot_runs" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "autopilot_steps_attempt_seq_uidx" ON "autopilot_steps" USING btree ("attempt_id","seq");--> statement-breakpoint
CREATE INDEX "autopilot_steps_run_idx" ON "autopilot_steps" USING btree ("run_id");