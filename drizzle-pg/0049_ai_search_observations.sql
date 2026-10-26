CREATE TABLE "ai_search_citations" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"title" text,
	"position" integer NOT NULL,
	"cited_at" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_search_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"model_name" text,
	"prompt_hash" text NOT NULL,
	"prompt_length" integer NOT NULL,
	"web_search" boolean NOT NULL,
	"country_code" text,
	"output_tokens" integer,
	"fan_out_count" integer DEFAULT 0 NOT NULL,
	"citation_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'success' NOT NULL,
	"event_key" text NOT NULL,
	"observed_at" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_search_citations" ADD CONSTRAINT "ai_search_citations_run_id_ai_search_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_search_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_search_citations" ADD CONSTRAINT "ai_search_citations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_search_runs" ADD CONSTRAINT "ai_search_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_search_citations_run_url_idx" ON "ai_search_citations" USING btree ("run_id","url");--> statement-breakpoint
CREATE INDEX "ai_search_citations_project_cited_idx" ON "ai_search_citations" USING btree ("project_id","cited_at");--> statement-breakpoint
CREATE INDEX "ai_search_runs_project_observed_idx" ON "ai_search_runs" USING btree ("project_id","observed_at");--> statement-breakpoint
CREATE INDEX "ai_search_runs_project_model_idx" ON "ai_search_runs" USING btree ("project_id","model");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_search_runs_event_model_idx" ON "ai_search_runs" USING btree ("project_id","event_key","model");