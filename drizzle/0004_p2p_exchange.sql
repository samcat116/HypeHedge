-- Drop old market system tables (AMM-based)
DROP TABLE IF EXISTS "trades" CASCADE;
DROP TABLE IF EXISTS "positions" CASCADE;
DROP TABLE IF EXISTS "market_pools" CASCADE;
DROP TABLE IF EXISTS "markets" CASCADE;

-- Add locked column to users for escrow
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locked" real DEFAULT 0 NOT NULL;

-- Change balance from integer to real for decimal precision
ALTER TABLE "users" ALTER COLUMN "balance" TYPE real;

-- Create new markets table with text IDs
CREATE TABLE "markets" (
	"id" text PRIMARY KEY NOT NULL,
	"number" serial NOT NULL,
	"guild_id" text NOT NULL,
	"creator_id" text NOT NULL,
	"description" text NOT NULL,
	"oracle_type" text NOT NULL,
	"oracle_user_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"winning_outcome_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);

-- Create outcomes table
CREATE TABLE "outcomes" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL REFERENCES "markets"("id"),
	"number" integer NOT NULL,
	"description" text NOT NULL
);

-- Create orders table (one order per user per market)
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL REFERENCES "markets"("id"),
	"outcome_id" text NOT NULL REFERENCES "outcomes"("id"),
	"direction" text NOT NULL,
	"quantity" integer NOT NULL,
	"price" real NOT NULL,
	"escrow_amount" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_user_id_market_id_unique" UNIQUE("user_id", "market_id")
);

-- Create new positions table with holdings as JSON
CREATE TABLE "positions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"market_id" text NOT NULL REFERENCES "markets"("id"),
	"holdings" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_user_id_market_id_unique" UNIQUE("user_id", "market_id")
);

-- Create executions table for trade history
CREATE TABLE "executions" (
	"id" text PRIMARY KEY NOT NULL,
	"market_id" text NOT NULL REFERENCES "markets"("id"),
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"participants" text NOT NULL
);
