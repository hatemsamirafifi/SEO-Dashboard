ALTER TABLE "rank_provider_calls" ADD COLUMN "skip_reason" text;--> statement-breakpoint
ALTER TABLE "rank_provider_calls" ADD COLUMN "circuit_reason" text;--> statement-breakpoint
ALTER TABLE "rank_provider_calls" ADD COLUMN "circuit_opened_at" text;--> statement-breakpoint
ALTER TABLE "rank_provider_calls" ADD COLUMN "circuit_expires_at" text;