CREATE TABLE "google_ads_planner_group_months" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"year" bigint NOT NULL,
	"month" bigint NOT NULL,
	"volume" bigint,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_ads_planner_group_variants" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"variant_keyword" text NOT NULL,
	"source_fetched_at" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_ads_planner_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"login_customer_id" text,
	"currency_code" text,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"network" text NOT NULL,
	"contract_version" text NOT NULL,
	"keyword" text NOT NULL,
	"avg_monthly_searches" bigint,
	"competition" text,
	"competition_index" bigint,
	"average_cpc_micros" bigint,
	"low_top_of_page_bid_micros" bigint,
	"high_top_of_page_bid_micros" bigint,
	"source_fetched_at" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_ads_planner_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"login_customer_id" text,
	"data_type" text NOT NULL,
	"currency_code" text,
	"location_code" integer NOT NULL,
	"language_code" text NOT NULL,
	"network" text NOT NULL,
	"contract_version" text NOT NULL,
	"seed_keyword" text DEFAULT '' NOT NULL,
	"source_fetched_at" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"partial" boolean DEFAULT false NOT NULL,
	"malformed_keyword_count" bigint DEFAULT 0 NOT NULL,
	"duplicate_keyword_count" bigint DEFAULT 0 NOT NULL,
	"missing_keyword_count" bigint DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_ads_planner_group_months" ADD CONSTRAINT "google_ads_planner_group_months_group_id_google_ads_planner_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."google_ads_planner_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_ads_planner_group_variants" ADD CONSTRAINT "google_ads_planner_group_variants_group_id_google_ads_planner_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."google_ads_planner_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_ads_planner_groups" ADD CONSTRAINT "google_ads_planner_groups_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_ads_planner_groups" ADD CONSTRAINT "google_ads_planner_groups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_ads_planner_observations" ADD CONSTRAINT "google_ads_planner_observations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_ads_planner_observations" ADD CONSTRAINT "google_ads_planner_observations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_ads_planner_group_months_group_month_idx" ON "google_ads_planner_group_months" USING btree ("group_id","year","month");--> statement-breakpoint
CREATE INDEX "google_ads_planner_group_months_group_idx" ON "google_ads_planner_group_months" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "google_ads_planner_group_variants_group_variant_idx" ON "google_ads_planner_group_variants" USING btree ("group_id","variant_keyword");--> statement-breakpoint
CREATE INDEX "google_ads_planner_group_variants_variant_idx" ON "google_ads_planner_group_variants" USING btree ("variant_keyword");--> statement-breakpoint
CREATE UNIQUE INDEX "google_ads_planner_groups_scope_keyword_idx" ON "google_ads_planner_groups" USING btree ("project_id","customer_id","location_code","language_code","network","contract_version","keyword");--> statement-breakpoint
CREATE INDEX "google_ads_planner_groups_organization_idx" ON "google_ads_planner_groups" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "google_ads_planner_groups_keyword_idx" ON "google_ads_planner_groups" USING btree ("project_id","customer_id","keyword");--> statement-breakpoint
CREATE UNIQUE INDEX "google_ads_planner_observations_scope_idx" ON "google_ads_planner_observations" USING btree ("project_id","customer_id","data_type","seed_keyword","location_code","language_code","network","contract_version");--> statement-breakpoint
CREATE INDEX "google_ads_planner_observations_organization_idx" ON "google_ads_planner_observations" USING btree ("organization_id");