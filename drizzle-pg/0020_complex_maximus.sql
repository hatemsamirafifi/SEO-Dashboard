CREATE TABLE "gsc_search_performance" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"gsc_connection_id" text,
	"property" text NOT NULL,
	"date" text NOT NULL,
	"grain" text NOT NULL,
	"grain_key" text NOT NULL,
	"query" text,
	"page" text,
	"country" text,
	"device" text,
	"search_appearance" text,
	"search_type" text DEFAULT 'web' NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"ctr" real DEFAULT 0 NOT NULL,
	"position" real DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gsc_search_performance_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"gsc_connection_id" text,
	"property" text NOT NULL,
	"sync_type" text NOT NULL,
	"requested_start_date" text NOT NULL,
	"requested_end_date" text NOT NULL,
	"actual_last_successful_date" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"completed_at" text,
	"rows_fetched" integer DEFAULT 0 NOT NULL,
	"rows_inserted" integer DEFAULT 0 NOT NULL,
	"rows_updated" integer DEFAULT 0 NOT NULL,
	"rows_failed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"checkpoint" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gsc_search_performance" ADD CONSTRAINT "gsc_search_performance_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_search_performance" ADD CONSTRAINT "gsc_search_performance_gsc_connection_id_gsc_connections_id_fk" FOREIGN KEY ("gsc_connection_id") REFERENCES "public"."gsc_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_search_performance_syncs" ADD CONSTRAINT "gsc_search_performance_syncs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_search_performance_syncs" ADD CONSTRAINT "gsc_search_performance_syncs_gsc_connection_id_gsc_connections_id_fk" FOREIGN KEY ("gsc_connection_id") REFERENCES "public"."gsc_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_search_perf_upsert_idx" ON "gsc_search_performance" USING btree ("project_id","property","search_type","date","grain","grain_key");--> statement-breakpoint
CREATE INDEX "gsc_search_perf_project_date_idx" ON "gsc_search_performance" USING btree ("project_id","date");--> statement-breakpoint
CREATE INDEX "gsc_search_perf_project_property_date_idx" ON "gsc_search_performance" USING btree ("project_id","property","date");--> statement-breakpoint
CREATE INDEX "gsc_search_perf_project_query_date_idx" ON "gsc_search_performance" USING btree ("project_id","query","date");--> statement-breakpoint
CREATE INDEX "gsc_search_perf_project_page_date_idx" ON "gsc_search_performance" USING btree ("project_id","page","date");--> statement-breakpoint
CREATE INDEX "gsc_search_perf_project_country_date_idx" ON "gsc_search_performance" USING btree ("project_id","country","date");--> statement-breakpoint
CREATE INDEX "gsc_search_perf_project_device_date_idx" ON "gsc_search_performance" USING btree ("project_id","device","date");--> statement-breakpoint
CREATE INDEX "gsc_search_perf_project_grain_date_idx" ON "gsc_search_performance" USING btree ("project_id","grain","date");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_sync_one_active_per_project_idx" ON "gsc_search_performance_syncs" USING btree ("project_id","property") WHERE "gsc_search_performance_syncs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE INDEX "gsc_sync_project_status_idx" ON "gsc_search_performance_syncs" USING btree ("project_id","status","started_at");