import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as runMigrations } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import * as schema from "../../src/db/schema.js";

const fixture = vi.hoisted(() => ({
	db: null as unknown,
	url: process.env.TEST_DATABASE_URL,
}));
vi.mock("../../src/db", () => ({
	get db() {
		return fixture.db;
	},
}));

const accountingMigration = readFileSync(
	new URL("../../drizzle/0006_fixed_precision_accounting.sql", import.meta.url),
	"utf8",
);
const legacyMigration = readFileSync(
	new URL("../../drizzle/0004_p2p_exchange.sql", import.meta.url),
	"utf8",
);
const identityMigration = readFileSync(
	new URL("../../drizzle/0005_serial_to_identity.sql", import.meta.url),
	"utf8",
);
const schemaName = `fixture_${randomUUID().replaceAll("-", "")}`;
let client: postgres.Sql;
let admin: postgres.Sql;
let database: typeof import("../../src/database.js");

async function migrate() {
	await client.begin(async (tx) => {
		for (const statement of accountingMigration.split(
			"--> statement-breakpoint",
		)) {
			if (statement.trim()) await tx.unsafe(statement);
		}
	});
}

describe.skipIf(!fixture.url)("PostgreSQL accounting fixtures", () => {
	beforeAll(async () => {
		const url = new URL(fixture.url ?? "");
		if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
			throw new Error(
				"Accounting fixtures require a loopback PostgreSQL server",
			);
		admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
		await admin.unsafe(`CREATE SCHEMA ${schemaName}`);
		client = postgres(url.toString(), {
			max: 5,
			onnotice: () => {},
			connection: { search_path: schemaName },
		});
		fixture.db = drizzle(client, { schema });
		database = await import("../../src/database.js");
	});

	beforeEach(async () => {
		await client.unsafe(
			`DROP SCHEMA ${schemaName} CASCADE; CREATE SCHEMA ${schemaName};`,
		);
		await client.unsafe(
			"CREATE TABLE users (discord_id text PRIMARY KEY, balance integer NOT NULL DEFAULT 0, created_at timestamptz DEFAULT now() NOT NULL)",
		);
		await client.unsafe(legacyMigration);
		await client.unsafe(identityMigration);
		await client.unsafe(
			"CREATE TABLE reactions (id serial PRIMARY KEY, message_id text NOT NULL, reactor_id text NOT NULL, author_id text NOT NULL, emoji text NOT NULL, created_at timestamptz DEFAULT now(), UNIQUE(message_id, reactor_id, emoji))",
		);
		await client`INSERT INTO markets(id, guild_id, creator_id, description, oracle_type) VALUES ('market', 'guild', 'creator', 'Fixture', 'manual')`;
		await client`INSERT INTO outcomes(id, market_id, number, description) VALUES ('yes', 'market', 1, 'Yes'), ('no', 'market', 2, 'No')`;
	});

	afterAll(async () => {
		if (client) await client.end();
		if (admin) {
			await admin.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
			await admin.end();
		}
	});

	it("converts large quantities, fractional holdings, signed execution history, and empty JSON", async () => {
		await client`INSERT INTO users(discord_id, balance, locked) VALUES ('buyer', 500000, 125000)`;
		await client`INSERT INTO orders(id, user_id, market_id, outcome_id, direction, quantity, price, escrow_amount) VALUES ('large', 'buyer', 'market', 'yes', 'buy', 250000, 0.5, 125000)`;
		await client`INSERT INTO positions(id, user_id, market_id, holdings) VALUES ('pos', 'buyer', 'market', '{"yes":1.2345,"no":2}'), ('empty', 'empty', 'market', '{}')`;
		await client`INSERT INTO executions(id, market_id, participants) VALUES ('history', 'market', '[{"userId":"buyer","outcomeId":"yes","quantity":-1.2345,"effectivePrice":0.29}]'), ('empty', 'market', '[]')`;
		await migrate();
		expect(
			Number(
				(await client`SELECT quantity_units FROM orders`)[0].quantity_units,
			),
		).toBe(2500000000);
		expect(
			JSON.parse(
				(await client`SELECT holdings FROM positions WHERE id='pos'`)[0]
					.holdings,
			),
		).toEqual({ yes: 12345, no: 20000 });
		expect(
			JSON.parse(
				(
					await client`SELECT participants FROM executions WHERE id='history'`
				)[0].participants,
			),
		).toEqual([
			{
				userId: "buyer",
				outcomeId: "yes",
				quantityUnits: -12345,
				effectivePriceUnits: 2900,
			},
		]);
		expect(
			(await client`SELECT holdings FROM positions WHERE id='empty'`)[0]
				.holdings,
		).toBe("{}");
		expect(
			(await client`SELECT participants FROM executions WHERE id='empty'`)[0]
				.participants,
		).toBe("[]");
	});

	it("rolls back instead of silently migrating inconsistent legacy escrow", async () => {
		await client`INSERT INTO users(discord_id, balance, locked) VALUES ('buyer', 10, 1)`;
		await expect(migrate()).rejects.toThrow("Legacy escrow");
		expect((await client`SELECT balance, locked FROM users`)[0]).toMatchObject({
			balance: 10,
			locked: 1,
		});
		expect(
			(
				await client`SELECT column_name FROM information_schema.columns WHERE table_schema=${schemaName} AND table_name='users'`
			).map((row) => row.column_name),
		).toContain("balance");
	});

	it("rejects unsafe balances without modifying legacy columns", async () => {
		await client`INSERT INTO users(discord_id, balance) VALUES ('unsafe', 1e12)`;
		await expect(migrate()).rejects.toThrow();
		expect(
			(await client`SELECT balance FROM users`)[0].balance,
		).toBeGreaterThan(0);
	});

	it("preserves locks through partial execution and cancellation, then pays resolution once", async () => {
		await client`INSERT INTO users(discord_id, balance) VALUES ('buyer', 10), ('seller', 10)`;
		await client`INSERT INTO positions(id, user_id, market_id, holdings) VALUES ('pos', 'seller', 'market', '{"yes":1}')`;
		await migrate();
		expect(
			(await database.createOrder("buyer", "market", "yes", "buy", 3, 6000))
				.success,
		).toBe(true);
		expect(
			(await database.createOrder("seller", "market", "yes", "sell", 1, 4000))
				.success,
		).toBe(true);
		expect((await database.executeMarket("market")).executions).toHaveLength(1);
		expect(await database.getBalance("buyer")).toEqual({
			balanceUnits: 95000,
			lockedUnits: 12000,
			availableUnits: 83000,
		});
		expect((await database.getOrder("buyer", "market"))?.escrowUnits).toBe(
			12000,
		);
		expect((await database.cancelOrder("buyer", "market")).success).toBe(true);
		expect((await database.getBalance("buyer")).lockedUnits).toBe(0);
		expect(
			(await database.resolveMarket("market", "yes"))?.totalPayoutUnits,
		).toBe(10000);
		expect(await database.resolveMarket("market", "yes")).toBeNull();
		expect((await database.getBalance("buyer")).balanceUnits).toBe(105000);
	});

	it("rejects invalid API quantities cleanly", async () => {
		await migrate();
		for (const quantity of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			1.5,
			-1,
			Number.MAX_SAFE_INTEGER,
		]) {
			expect(
				(
					await database.createOrder(
						"buyer",
						"market",
						"yes",
						"buy",
						quantity,
						5000,
					)
				).success,
			).toBe(false);
		}
	});

	it("removes a reaction from fractional spendable funds without violating nonnegative balances", async () => {
		await migrate();
		await client`INSERT INTO users(discord_id, balance_units, locked_units) VALUES ('author', 5000, 2000)`;
		await client`INSERT INTO reactions(message_id, reactor_id, author_id, emoji) VALUES ('message', 'reactor', 'author', 'x')`;
		expect(await database.removeReaction("message", "reactor", "x")).toBe(true);
		expect(await database.getBalance("author")).toEqual({
			balanceUnits: 2000,
			lockedUnits: 2000,
			availableUnits: 0,
		});
	});
	it("refuses legacy negative holdings and rolls back the conversion", async () => {
		await client`INSERT INTO positions(id, user_id, market_id, holdings) VALUES ('short', 'seller', 'market', '{"yes":-1}')`;
		await expect(migrate()).rejects.toThrow("Legacy short holdings");
		expect(
			JSON.parse((await client`SELECT holdings FROM positions`)[0].holdings),
		).toEqual({ yes: -1 });
	});

	it.each(["yes", "no"])(
		"backs short fills and conserves currency when %s wins",
		async (winner) => {
			await client`INSERT INTO users(discord_id, balance) VALUES ('buyer', 10), ('seller', 10)`;
			await migrate();
			expect(
				(await database.createOrder("buyer", "market", "yes", "buy", 2, 6000))
					.success,
			).toBe(true);
			expect(
				(await database.createOrder("seller", "market", "yes", "sell", 2, 4000))
					.success,
			).toBe(true);
			await database.executeMarket("market");
			expect((await database.getBalance("buyer")).balanceUnits).toBe(90000);
			expect((await database.getBalance("seller")).balanceUnits).toBe(90000);
			expect(
				(await database.getPosition("seller", "market"))?.holdings,
			).toEqual({ no: 20000 });
			await database.resolveMarket("market", winner);
			expect(
				(await database.getBalance("buyer")).balanceUnits +
					(await database.getBalance("seller")).balanceUnits,
			).toBe(200000);
		},
	);

	it("retains short collateral while the owned portion is partially sold", async () => {
		await client`INSERT INTO users(discord_id, balance) VALUES ('buyer', 10), ('seller', 10)`;
		await client`INSERT INTO positions(id, user_id, market_id, holdings) VALUES ('owned', 'seller', 'market', '{"yes":1}')`;
		await migrate();
		await database.createOrder("seller", "market", "yes", "sell", 3, 4000);
		await database.createOrder("buyer", "market", "yes", "buy", 1, 6000);
		await database.executeMarket("market");
		expect((await database.getBalance("seller")).lockedUnits).toBe(12000);
		expect((await database.getOrder("seller", "market"))?.escrowUnits).toBe(
			12000,
		);
		await database.createOrder("buyer", "market", "yes", "buy", 2, 6000);
		await database.executeMarket("market");
		expect(await database.getBalance("seller")).toEqual({
			balanceUnits: 95000,
			lockedUnits: 0,
			availableUnits: 95000,
		});
		expect((await database.getPosition("seller", "market"))?.holdings).toEqual({
			no: 20000,
		});
	});

	it("serializes concurrent matching so a fill is applied once", async () => {
		await client`INSERT INTO users(discord_id, balance) VALUES ('buyer', 10), ('seller', 10)`;
		await client`INSERT INTO positions(id, user_id, market_id, holdings) VALUES ('owned', 'seller', 'market', '{"yes":1}')`;
		await migrate();
		await database.createOrder("buyer", "market", "yes", "buy", 1, 6000);
		await database.createOrder("seller", "market", "yes", "sell", 1, 4000);
		const results = await Promise.all([
			database.executeMarket("market"),
			database.executeMarket("market"),
		]);
		expect(results.flatMap((result) => result.executions)).toHaveLength(1);
		expect((await database.getBalance("buyer")).balanceUnits).toBe(95000);
	});
	it("serializes reservations across markets sharing a balance", async () => {
		await client`INSERT INTO users(discord_id, balance) VALUES ('buyer', 1)`;
		await client`INSERT INTO markets(id, guild_id, creator_id, description, oracle_type) VALUES ('other-market', 'guild', 'creator', 'Fixture 2', 'manual')`;
		await client`INSERT INTO outcomes(id, market_id, number, description) VALUES ('other-yes', 'other-market', 1, 'Yes')`;
		await migrate();
		const results = await Promise.all([
			database.createOrder("buyer", "market", "yes", "buy", 1, 6000),
			database.createOrder(
				"buyer",
				"other-market",
				"other-yes",
				"buy",
				1,
				6000,
			),
		]);
		expect(results.filter((result) => result.success)).toHaveLength(1);
		expect(results.find((result) => !result.success)?.error).toContain(
			"Insufficient balance",
		);
		expect((await database.getBalance("buyer")).lockedUnits).toBe(6000);
	});

	it("debits a duplicate reaction removal only once", async () => {
		await migrate();
		await client`INSERT INTO users(discord_id, balance_units) VALUES ('author', 30000)`;
		await client`INSERT INTO reactions(message_id, reactor_id, author_id, emoji) VALUES ('message', 'reactor', 'author', 'x')`;
		const results = await Promise.all([
			database.removeReaction("message", "reactor", "x"),
			database.removeReaction("message", "reactor", "x"),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect((await database.getBalance("author")).balanceUnits).toBe(20000);
	});
	it("rejects undercollateralized legacy orders even when locks match escrow", async () => {
		await client`INSERT INTO users(discord_id, balance, locked) VALUES ('buyer', 10, 1)`;
		await client`INSERT INTO orders(id, user_id, market_id, outcome_id, direction, quantity, price, escrow_amount) VALUES ('underfunded', 'buyer', 'market', 'yes', 'buy', 10, 0.5, 1)`;
		await expect(migrate()).rejects.toThrow("insufficient escrow");
		expect((await client`SELECT quantity FROM orders`)[0].quantity).toBe(10);
	});
	it("applies migration 0006 through Drizzle once with its journal and snapshot", async () => {
		await client`INSERT INTO users(discord_id, balance) VALUES ('buyer', 10)`;
		await client.unsafe(
			`CREATE TABLE ${schemaName}.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
		);
		const previous = readMigrationFiles({ migrationsFolder: "./drizzle" })[5];
		await client`INSERT INTO __drizzle_migrations(hash, created_at) VALUES (${previous.hash}, ${previous.folderMillis})`;
		const fixtureDb = drizzle(client);
		await runMigrations(fixtureDb, {
			migrationsFolder: "./drizzle",
			migrationsSchema: schemaName,
		});
		await runMigrations(fixtureDb, {
			migrationsFolder: "./drizzle",
			migrationsSchema: schemaName,
		});
		expect((await database.getBalance("buyer")).balanceUnits).toBe(100000);
		expect(
			(await client`SELECT count(*)::int AS count FROM __drizzle_migrations`)[0]
				.count,
		).toBe(2);
	});
});
