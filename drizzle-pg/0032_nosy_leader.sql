CREATE TABLE "opportunities" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"logical_key" text NOT NULL,
	"occurrence_number" integer DEFAULT 1 NOT NULL,
	"type" text NOT NULL,
	"detector_key" text NOT NULL,
	"detector_version" integer NOT NULL,
	"score_version" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"impact_score" integer NOT NULL,
	"confidence_score" integer NOT NULL,
	"priority" text NOT NULL,
	"title" text NOT NULL,
	"explanation_fact" text NOT NULL,
	"recommendation" text NOT NULL,
	"evidence_json" text NOT NULL,
	"keyword" text,
	"page" text,
	"source_metrics_json" text,
	"sources_json" text DEFAULT '[]' NOT NULL,
	"impact_factors_json" text,
	"confidence_inputs_json" text,
	"last_seen_scan_id" text,
	"consecutive_misses" integer DEFAULT 0 NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"stale_at" text,
	"recurrence_of_id" text,
	"superseded_by_id" text,
	"first_detected_at" text NOT NULL,
	"last_detected_at" text NOT NULL,
	"completed_at" text,
	"dismissed_at" text,
	"dismissal_reason" text,
	"created_at" text DEFAULT (current_timestamp) NOT NULL,
	"updated_at" text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_events" (
	"id" text PRIMARY KEY NOT NULL,
	"occurrence_id" text NOT NULL,
	"type" text NOT NULL,
	"event_key" text NOT NULL,
	"scan_id" text,
	"payload_json" text,
	"created_at" text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_events" ADD CONSTRAINT "opportunity_events_occurrence_id_opportunities_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_active_key_uidx" ON "opportunities" USING btree ("project_id","logical_key") WHERE "opportunities"."status" IN ('open', 'in_progress');--> statement-breakpoint
CREATE INDEX "opportunities_project_status_idx" ON "opportunities" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "opportunities_project_type_status_idx" ON "opportunities" USING btree ("project_id","type","status");--> statement-breakpoint
CREATE INDEX "opportunities_project_priority_impact_idx" ON "opportunities" USING btree ("project_id","priority","impact_score");--> statement-breakpoint
CREATE INDEX "opportunities_project_page_idx" ON "opportunities" USING btree ("project_id","page");--> statement-breakpoint
CREATE INDEX "opportunities_project_keyword_idx" ON "opportunities" USING btree ("project_id","keyword");--> statement-breakpoint
CREATE INDEX "opportunities_recurrence_of_idx" ON "opportunities" USING btree ("recurrence_of_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_events_occurrence_key_uidx" ON "opportunity_events" USING btree ("occurrence_id","event_key");--> statement-breakpoint
CREATE INDEX "opportunity_events_occurrence_created_idx" ON "opportunity_events" USING btree ("occurrence_id","created_at");