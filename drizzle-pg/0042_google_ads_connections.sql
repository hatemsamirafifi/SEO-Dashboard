CREATE TABLE "google_ads_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"login_customer_id" text,
	"customer_display_name" text,
	"grant_account_id" text NOT NULL,
	"connected_by_user_id" text NOT NULL,
	"currency_code" text,
	"time_zone" text,
	"is_test_account" boolean DEFAULT false NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_ads_connections" ADD CONSTRAINT "google_ads_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_ads_connections" ADD CONSTRAINT "google_ads_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_ads_connections_project_idx" ON "google_ads_connections" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "google_ads_connections_organization_idx" ON "google_ads_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "google_ads_connections_user_grant_idx" ON "google_ads_connections" USING btree ("connected_by_user_id","grant_account_id");