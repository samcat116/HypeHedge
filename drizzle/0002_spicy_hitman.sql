CREATE TABLE "market_pools" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" bigserial NOT NULL,
	"liquidity" integer DEFAULT 100 NOT NULL,
	"outcome_shares" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_pools_market_id_unique" UNIQUE("market_id")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" bigserial NOT NULL,
	"user_id" text NOT NULL,
	"outcome" text NOT NULL,
	"shares" integer DEFAULT 0 NOT NULL,
	"avg_cost_basis" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "positions_market_id_user_id_outcome_unique" UNIQUE("market_id","user_id","outcome")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"market_id" bigserial NOT NULL,
	"user_id" text NOT NULL,
	"outcome" text NOT NULL,
	"trade_type" text NOT NULL,
	"shares" integer NOT NULL,
	"price" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "market_pools" ADD CONSTRAINT "market_pools_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;