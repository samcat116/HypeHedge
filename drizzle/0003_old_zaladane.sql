ALTER TABLE "market_pools" ALTER COLUMN "market_id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "positions" ALTER COLUMN "market_id" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "trades" ALTER COLUMN "market_id" SET DATA TYPE bigint;