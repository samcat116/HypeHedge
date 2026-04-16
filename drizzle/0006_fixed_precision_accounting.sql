-- Convert accounting values from floating-point coins/prices to scaled integer units.
-- Scale: 10,000 units = 1 coin, 1 contract, or 100% price.

ALTER TABLE "users" RENAME COLUMN "balance" TO "balance_units";
ALTER TABLE "users" RENAME COLUMN "locked" TO "locked_units";

ALTER TABLE "users"
	ALTER COLUMN "balance_units" TYPE bigint USING round("balance_units"::numeric * 10000)::bigint,
	ALTER COLUMN "balance_units" SET DEFAULT 0,
	ALTER COLUMN "locked_units" TYPE bigint USING round("locked_units"::numeric * 10000)::bigint,
	ALTER COLUMN "locked_units" SET DEFAULT 0;

ALTER TABLE "orders" RENAME COLUMN "quantity" TO "quantity_units";
ALTER TABLE "orders" RENAME COLUMN "price" TO "price_units";
ALTER TABLE "orders" RENAME COLUMN "escrow_amount" TO "escrow_units";

ALTER TABLE "orders"
	ALTER COLUMN "quantity_units" TYPE integer USING ("quantity_units" * 10000),
	ALTER COLUMN "price_units" TYPE integer USING round("price_units"::numeric * 10000)::integer,
	ALTER COLUMN "escrow_units" TYPE bigint USING round("escrow_units"::numeric * 10000)::bigint;

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

ALTER TABLE "users"
	ADD CONSTRAINT "users_balance_units_nonnegative" CHECK ("balance_units" >= 0),
	ADD CONSTRAINT "users_locked_units_nonnegative" CHECK ("locked_units" >= 0);

ALTER TABLE "orders"
	ADD CONSTRAINT "orders_quantity_units_positive" CHECK ("quantity_units" > 0),
	ADD CONSTRAINT "orders_price_units_range" CHECK ("price_units" > 0 AND "price_units" < 10000),
	ADD CONSTRAINT "orders_escrow_units_nonnegative" CHECK ("escrow_units" >= 0);
