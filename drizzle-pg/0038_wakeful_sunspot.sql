CREATE TABLE "ga4_daily_geo" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"property_id" text NOT NULL,
	"ga4_connection_id" text,
	"date" text NOT NULL,
	"country" text NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"engaged_sessions" integer DEFAULT 0 NOT NULL,
	"user_engagement_duration" real DEFAULT 0 NOT NULL,
	"screen_page_views" integer DEFAULT 0 NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"new_users" integer DEFAULT 0 NOT NULL,
	"is_other_row" boolean DEFAULT false NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ga4_daily_technology" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"property_id" text NOT NULL,
	"ga4_connection_id" text,
	"date" text NOT NULL,
	"device" text NOT NULL,
	"browser" text NOT NULL,
	"os" text NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"engaged_sessions" integer DEFAULT 0 NOT NULL,
	"user_engagement_duration" real DEFAULT 0 NOT NULL,
	"screen_page_views" integer DEFAULT 0 NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"new_users" integer DEFAULT 0 NOT NULL,
	"is_other_row" boolean DEFAULT false NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ga4_daily_geo" ADD CONSTRAINT "ga4_daily_geo_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ga4_daily_geo" ADD CONSTRAINT "ga4_daily_geo_ga4_connection_id_ga4_connections_id_fk" FOREIGN KEY ("ga4_connection_id") REFERENCES "public"."ga4_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ga4_daily_technology" ADD CONSTRAINT "ga4_daily_technology_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ga4_daily_technology" ADD CONSTRAINT "ga4_daily_technology_ga4_connection_id_ga4_connections_id_fk" FOREIGN KEY ("ga4_connection_id") REFERENCES "public"."ga4_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ga4_geo_upsert_idx" ON "ga4_daily_geo" USING btree ("project_id","property_id","date","country");--> statement-breakpoint
CREATE INDEX "ga4_geo_project_date_idx" ON "ga4_daily_geo" USING btree ("project_id","date");--> statement-breakpoint
CREATE INDEX "ga4_geo_project_country_date_idx" ON "ga4_daily_geo" USING btree ("project_id","country","date");--> statement-breakpoint
CREATE UNIQUE INDEX "ga4_technology_upsert_idx" ON "ga4_daily_technology" USING btree ("project_id","property_id","date","device","browser","os");--> statement-breakpoint
CREATE INDEX "ga4_technology_project_date_idx" ON "ga4_daily_technology" USING btree ("project_id","date");--> statement-breakpoint
CREATE INDEX "ga4_technology_project_device_date_idx" ON "ga4_daily_technology" USING btree ("project_id","device","date");