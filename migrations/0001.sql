PRAGMA foreign_keys = ON;
CREATE TABLE revision (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 0 AND 9007199254740991));
INSERT INTO revision VALUES (1,0);
-- An explicit failing CHECK turns a zero-row optimistic guard into batch rollback.
CREATE TABLE operation_assertions (ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE operation_receipts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)), created_at INTEGER NOT NULL);
CREATE TABLE users (
 discord_id TEXT PRIMARY KEY,
 balance_units INTEGER NOT NULL DEFAULT 0 CHECK(typeof(balance_units)='integer' AND balance_units BETWEEN 0 AND 9007199254740991),
 locked_units INTEGER NOT NULL DEFAULT 0 CHECK(typeof(locked_units)='integer' AND locked_units BETWEEN 0 AND balance_units)
);
CREATE TABLE markets (
 id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE CHECK(number BETWEEN 1 AND 9007199254740991), guild_id TEXT NOT NULL, creator_id TEXT NOT NULL,
 description TEXT NOT NULL, oracle_type TEXT NOT NULL DEFAULT 'manual' CHECK(oracle_type='manual'), oracle_user_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')), winning_outcome_id TEXT,
 collateral_units INTEGER NOT NULL DEFAULT 0 CHECK(typeof(collateral_units)='integer' AND collateral_units BETWEEN 0 AND 9007199254740991),
 created_at INTEGER NOT NULL, resolved_at INTEGER,
 CHECK((status='open' AND winning_outcome_id IS NULL AND resolved_at IS NULL) OR (status='resolved' AND winning_outcome_id IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE TABLE outcomes (id TEXT PRIMARY KEY, market_id TEXT NOT NULL REFERENCES markets(id), number INTEGER NOT NULL, description TEXT NOT NULL, UNIQUE(market_id,number), UNIQUE(id,market_id));
CREATE TABLE orders (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(discord_id), market_id TEXT NOT NULL REFERENCES markets(id), outcome_id TEXT NOT NULL,
 direction TEXT NOT NULL CHECK(direction IN ('buy','sell')),
 quantity_units INTEGER NOT NULL CHECK(typeof(quantity_units)='integer' AND quantity_units BETWEEN 1 AND 9007199254740991),
 price_units INTEGER NOT NULL CHECK(typeof(price_units)='integer' AND price_units BETWEEN 1 AND 9999),
 escrow_units INTEGER NOT NULL CHECK(typeof(escrow_units)='integer' AND escrow_units BETWEEN 0 AND 9007199254740991), created_at INTEGER NOT NULL,
 UNIQUE(user_id,market_id), FOREIGN KEY(outcome_id,market_id) REFERENCES outcomes(id,market_id)
);
CREATE TABLE positions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(discord_id), market_id TEXT NOT NULL REFERENCES markets(id), holdings TEXT NOT NULL CHECK(json_valid(holdings) AND json_type(holdings)='object'), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id,market_id));
CREATE TRIGGER positions_insert BEFORE INSERT ON positions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.holdings) j WHERE j.type!='integer' OR j.value<0 OR j.value>9007199254740991 OR NOT EXISTS(SELECT 1 FROM outcomes o WHERE o.id=j.key AND o.market_id=NEW.market_id)) THEN RAISE(ABORT,'invalid holdings') END;
END;
CREATE TRIGGER positions_update BEFORE UPDATE ON positions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.holdings) j WHERE j.type!='integer' OR j.value<0 OR j.value>9007199254740991 OR NOT EXISTS(SELECT 1 FROM outcomes o WHERE o.id=j.key AND o.market_id=NEW.market_id)) THEN RAISE(ABORT,'invalid holdings') END;
END;
CREATE TABLE executions (id TEXT PRIMARY KEY, market_id TEXT NOT NULL REFERENCES markets(id), timestamp INTEGER NOT NULL, participants TEXT NOT NULL CHECK(json_valid(participants)));
-- Tombstones retain outstanding credit when a removed award could not be reclaimed.
CREATE TABLE reactions (message_id TEXT NOT NULL, reactor_id TEXT NOT NULL, emoji TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(discord_id), active INTEGER NOT NULL CHECK(active IN(0,1)), credited_units INTEGER NOT NULL CHECK(typeof(credited_units)='integer' AND credited_units BETWEEN 0 AND 10000), PRIMARY KEY(message_id,reactor_id,emoji));
CREATE TABLE backfill_progress (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, last_message_id TEXT, messages_processed INTEGER NOT NULL DEFAULT 0, reactions_added INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', updated_at INTEGER NOT NULL, PRIMARY KEY(guild_id,channel_id));
CREATE INDEX orders_market ON orders(market_id);
CREATE INDEX positions_market ON positions(market_id);
CREATE INDEX markets_guild ON markets(guild_id,status);
