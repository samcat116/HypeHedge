-- Convert markets.number from SERIAL to IDENTITY
-- First, get current max value to set identity start
DO $$
DECLARE
    max_num INTEGER;
BEGIN
    SELECT COALESCE(MAX(number), 0) INTO max_num FROM markets;

    -- Drop the default (sequence) from the column
    ALTER TABLE "markets" ALTER COLUMN "number" DROP DEFAULT;

    -- Drop the old sequence
    DROP SEQUENCE IF EXISTS markets_number_seq;

    -- Add identity to the column, starting after the max existing value
    EXECUTE format('ALTER TABLE "markets" ALTER COLUMN "number" ADD GENERATED ALWAYS AS IDENTITY (START WITH %s)', max_num + 1);
END $$;
