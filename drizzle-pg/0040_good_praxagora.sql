CREATE TABLE "report_schedule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"scheduled_for" text NOT NULL,
	"report_id" text,
	"state" text NOT NULL,
	"failure_class" text,
	"skip_reason" text,
	"recipient_outcomes" text,
	"claimed_at" text NOT NULL,
	"completed_at" text,
	"created_at" text DEFAULT (current_timestamp) NOT NULL,
	"updated_at" text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"report_type" text NOT NULL,
	"cadence" text NOT NULL,
	"recipients" text NOT NULL,
	"share_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"paused_at" text,
	"next_due_at" text NOT NULL,
	"last_run_at" text,
	"created_by_user_id" text,
	"created_at" text DEFAULT (current_timestamp) NOT NULL,
	"updated_at" text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_schedule_runs" ADD CONSTRAINT "report_schedule_runs_schedule_id_report_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."report_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedule_runs" ADD CONSTRAINT "report_schedule_runs_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_schedule_runs_unique_schedule_for_idx" ON "report_schedule_runs" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "report_schedule_runs_schedule_idx" ON "report_schedule_runs" USING btree ("schedule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "report_schedules_project_idx" ON "report_schedules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "report_schedules_due_idx" ON "report_schedules" USING btree ("active","next_due_at");