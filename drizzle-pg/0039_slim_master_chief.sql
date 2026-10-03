CREATE TABLE "ga4_project_goals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"event_name" text NOT NULL,
	"match_key_event_only" boolean DEFAULT false NOT NULL,
	"archived_at" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ga4_project_goals" ADD CONSTRAINT "ga4_project_goals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ga4_project_goals" ADD CONSTRAINT "ga4_project_goals_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ga4_goals_project_name_active_uidx" ON "ga4_project_goals" USING btree ("project_id","name") WHERE "ga4_project_goals"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ga4_goals_project_idx" ON "ga4_project_goals" USING btree ("project_id");