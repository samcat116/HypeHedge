CREATE TABLE "markets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"creator_id" text NOT NULL,
	"oracle_id" text NOT NULL,
	"description" text NOT NULL,
	"outcome_type" text NOT NULL,
	"options" text[],
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
