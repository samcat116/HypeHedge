-- Convert accounting values from floating-point coins/prices to scaled integer units.
-- Scale: 10,000 units = 1 coin, 1 contract, or 100% price.

ALTER TABLE "users" RENAME COLUMN "balance" TO "balance_units";
--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "locked" TO "locked_units";
--> statement-breakpoint

ALTER TABLE "users"
	ALTER COLUMN "balance_units" TYPE bigint USING round("balance_units"::numeric * 10000)::bigint,
	ALTER COLUMN "balance_units" SET DEFAULT 0,
	ALTER COLUMN "locked_units" TYPE bigint USING round("locked_units"::numeric * 10000)::bigint,
	ALTER COLUMN "locked_units" SET DEFAULT 0;
--> statement-breakpoint

ALTER TABLE "orders" RENAME COLUMN "quantity" TO "quantity_units";
--> statement-breakpoint
ALTER TABLE "orders" RENAME COLUMN "price" TO "price_units";
--> statement-breakpoint
ALTER TABLE "orders" RENAME COLUMN "escrow_amount" TO "escrow_units";
--> statement-breakpoint

ALTER TABLE "orders"
	ALTER COLUMN "quantity_units" TYPE bigint USING ("quantity_units"::bigint * 10000),
	ALTER COLUMN "price_units" TYPE integer USING round("price_units"::numeric * 10000)::integer,
	ALTER COLUMN "escrow_units" TYPE bigint USING round("escrow_units"::numeric * 10000)::bigint;
--> statement-breakpoint

UPDATE "positions"
SET "holdings" = COALESCE(
	(
		SELECT jsonb_object_agg(
			key,
			round(value::numeric * 10000)::bigint
		)
		FROM jsonb_each_text("positions"."holdings"::jsonb)
	),
	'{}'::jsonb
)::text;
--> statement-breakpoint

UPDATE "executions"
SET "participants" = COALESCE(
	(
		SELECT jsonb_agg(
			(elem - 'quantity' - 'effectivePrice') ||
			jsonb_build_object(
				'quantityUnits',
				round((elem->>'quantity')::numeric * 10000)::bigint,
				'effectivePriceUnits',
				round((elem->>'effectivePrice')::numeric * 10000)::integer
			)
		)
		FROM jsonb_array_elements("executions"."participants"::jsonb) elem
	),
	'[]'::jsonb
)::text;
--> statement-breakpoint

ALTER TABLE "users"
	ADD CONSTRAINT "users_balance_units_nonnegative" CHECK ("balance_units" BETWEEN 0 AND 9007199254740991),
	ADD CONSTRAINT "users_locked_units_nonnegative" CHECK ("locked_units" BETWEEN 0 AND 9007199254740991),
	ADD CONSTRAINT "users_locked_units_covered" CHECK ("locked_units" <= "balance_units");
--> statement-breakpoint

ALTER TABLE "orders"
	ADD CONSTRAINT "orders_quantity_units_positive" CHECK ("quantity_units" BETWEEN 1 AND 9007199254740991),
	ADD CONSTRAINT "orders_price_units_range" CHECK ("price_units" > 0 AND "price_units" < 10000),
	ADD CONSTRAINT "orders_escrow_units_nonnegative" CHECK ("escrow_units" BETWEEN 0 AND 9007199254740991);
--> statement-breakpoint


-- Fail closed rather than guess how to repair historical drift or malformed JSON.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM positions p, LATERAL jsonb_each_text(p.holdings::jsonb) h
		WHERE h.value IS NULL OR h.value::numeric < 0 OR h.value::numeric > 9007199254740991
	) OR EXISTS (
		SELECT 1 FROM executions e, LATERAL jsonb_array_elements(e.participants::jsonb) party
		WHERE party->>'quantityUnits' IS NULL OR party->>'effectivePriceUnits' IS NULL
			OR abs((party->>'quantityUnits')::numeric) > 9007199254740991
			OR (party->>'effectivePriceUnits')::numeric NOT BETWEEN 0 AND 10000
	) THEN
		RAISE EXCEPTION 'Legacy short holdings, unsafe accounting JSON, or missing/invalid fields require reconciliation';
	END IF;
	IF EXISTS (
		SELECT 1 FROM users u
		WHERE u.locked_units <> COALESCE((SELECT sum(o.escrow_units) FROM orders o WHERE o.user_id = u.discord_id), 0)
	) OR EXISTS (
		SELECT 1 FROM orders o LEFT JOIN users u ON u.discord_id = o.user_id WHERE u.discord_id IS NULL
	) THEN
		RAISE EXCEPTION 'Legacy escrow does not reconcile with user locks; reconcile a backup before retrying';
	END IF;
	IF EXISTS (
		SELECT 1 FROM orders o
		LEFT JOIN positions p ON p.user_id = o.user_id AND p.market_id = o.market_id
		WHERE o.direction NOT IN ('buy', 'sell') OR o.escrow_units < CASE
			WHEN o.direction = 'buy' THEN ceil(o.quantity_units::numeric * o.price_units / 10000)
			ELSE ceil(GREATEST(0, o.quantity_units::numeric - COALESCE((p.holdings::jsonb->>o.outcome_id)::numeric, 0)) * (10000 - o.price_units) / 10000)
		END
	) THEN
		RAISE EXCEPTION 'Legacy orders have invalid direction or insufficient escrow; reconcile before retrying';
	END IF;
END $$;
