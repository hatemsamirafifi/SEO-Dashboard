CREATE TABLE "competitor_gap_verdicts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"verdict" text NOT NULL,
	"evidence" text NOT NULL,
	"thresholds" text NOT NULL,
	"input_manifest" text NOT NULL,
	"recorded_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competitor_gap_verdicts" ADD CONSTRAINT "competitor_gap_verdicts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_gap_verdicts" ADD CONSTRAINT "competitor_gap_verdicts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_gap_verdicts_latest_idx" ON "competitor_gap_verdicts" USING btree ("organization_id","project_id","recorded_at");