ALTER TABLE "rank_provider_calls" ADD COLUMN "requested_depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_provider_calls" ADD COLUMN "pages_requested" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_provider_calls" ADD COLUMN "result_completeness" text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_provider_calls" ADD COLUMN "dispatched" boolean DEFAULT true NOT NULL;
