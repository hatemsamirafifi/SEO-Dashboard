ALTER TABLE "rank_snapshots" ALTER COLUMN "ranking_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ALTER COLUMN "ranking_status" DROP NOT NULL;