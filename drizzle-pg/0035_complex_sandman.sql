CREATE TABLE "organization_branding" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"agency_name" text DEFAULT '' NOT NULL,
	"agency_logo_r2_key" text,
	"accent_color" text,
	"footer_text" text,
	"created_at" text DEFAULT (current_timestamp) NOT NULL,
	"updated_at" text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_client_profiles" (
	"project_id" text PRIMARY KEY NOT NULL,
	"client_name" text DEFAULT '' NOT NULL,
	"client_logo_r2_key" text,
	"report_title_override" text,
	"notes" text,
	"created_at" text DEFAULT (current_timestamp) NOT NULL,
	"updated_at" text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_events" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"organization_id" text,
	"type" text NOT NULL,
	"user_id" text,
	"metadata_json" text,
	"created_at" text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" text,
	"expires_at" text,
	"revoked_at" text,
	"view_count" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT (current_timestamp) NOT NULL,
	CONSTRAINT "report_shares_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "branding_snapshot_json" text;--> statement-breakpoint
ALTER TABLE "organization_branding" ADD CONSTRAINT "organization_branding_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_client_profiles" ADD CONSTRAINT "project_client_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_events" ADD CONSTRAINT "report_events_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_shares" ADD CONSTRAINT "report_shares_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_shares" ADD CONSTRAINT "report_shares_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_events_report_idx" ON "report_events" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "report_shares_report_idx" ON "report_shares" USING btree ("report_id");