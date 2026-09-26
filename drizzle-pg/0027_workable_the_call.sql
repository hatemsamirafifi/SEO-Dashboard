ALTER TABLE "rank_provider_calls" ADD COLUMN "attempt" integer;--> statement-breakpoint
ALTER TABLE "rank_provider_calls" ADD COLUMN "max_retries" integer;--> statement-breakpoint
ALTER TABLE "rank_provider_calls" ADD COLUMN "retryable" boolean;--> statement-breakpoint
ALTER TABLE "rank_provider_calls" ADD COLUMN "retry_after_ms" integer;--> statement-breakpoint
ALTER TABLE "seo_provider_settings" ADD COLUMN "max_retries" integer DEFAULT 2 NOT NULL;