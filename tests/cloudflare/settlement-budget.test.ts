import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	D1QueryBudget,
	D1QueryBudgetExceeded,
} from "../../src/cloudflare/d1-budget";
import {
	type DiscordInteraction,
	executeInteraction,
} from "../../src/cloudflare/interactions";
import { Database } from "../../src/database";

type StatementSpec = { sql: string; values: unknown[] };
function observed(
	hook?: (
		statements: D1PreparedStatement[],
		specs: StatementSpec[],
		attempt: number,
	) => Promise<D1PreparedStatement[]>,
	after?: () => void,
) {
	const specs = new WeakMap<D1PreparedStatement, StatementSpec>();
	const raw = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
	let reads = 0;
	let batches = 0;
	let statements = 0;
	let maxParameters = 0;
	function statement(
		value: D1PreparedStatement,
		spec: StatementSpec,
	): D1PreparedStatement {
		const wrapped = new Proxy(value, {
			get(target, key) {
				if (key === "bind")
					return (...values: unknown[]) => {
						maxParameters = Math.max(maxParameters, values.length);
						return statement(target.bind(...values), { sql: spec.sql, values });
					};
				const result = Reflect.get(target, key, target);
				if (["all", "first", "raw", "run"].includes(String(key)))
					return (...args: unknown[]) => {
						reads++;
						return Reflect.apply(result, target, args);
					};
				return typeof result === "function" ? result.bind(target) : result;
			},
		});
		specs.set(wrapped, spec);
		raw.set(wrapped, value);
		return wrapped;
	}
	const db = new Proxy(env.DB, {
		get(target, key) {
			if (key === "prepare")
				return (sql: string) =>
					statement(target.prepare(sql), { sql, values: [] });
			if (key === "batch")
				return async (batch: D1PreparedStatement[]) => {
					batches++;
					statements += batch.length;
					const entries = batch.map(
						(s) => specs.get(s) ?? { sql: "", values: [] },
					);
					let real = batch.map((s) => raw.get(s) ?? s);
					if (hook) real = await hook(real, entries, batches);
					const result = await target.batch(real);
					after?.();
					return result;
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		db,
		get total() {
			return reads + statements;
		},
		get transportCalls() {
			return reads + batches;
		},
		get reads() {
			return reads;
		},
		get statements() {
			return statements;
		},
		get maxParameters() {
			return maxParameters;
		},
	};
}
const users = Array.from({ length: 80 }, (_, n) => `900719925474099${100 + n}`);
async function fixture(count = 80) {
	const store = new Database(env.DB);
	const market = await store.createMarket({
		guildId: "741",
		creatorId: "742",
		oracleUserId: "742",
		description: "Budget market",
		outcomeDescriptions: ["Yes", "No"],
	});
	const [yes, no] = market.outcomes;
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO users(discord_id,balance_units,locked_units) SELECT value,100000,100 FROM json_each(?)",
		).bind(JSON.stringify(users.slice(0, count))),
		env.DB.prepare(
			"INSERT INTO positions SELECT value,value,?,json_object(?,10000,?,10000),0,0 FROM json_each(?)",
		).bind(market.id, yes.id, no.id, JSON.stringify(users.slice(0, count))),
		env.DB.prepare(
			"INSERT INTO orders SELECT value,value,?,?, 'buy',10000,100,100,0 FROM json_each(?)",
		).bind(market.id, yes.id, JSON.stringify(users.slice(0, count))),
		env.DB.prepare("UPDATE markets SET collateral_units=? WHERE id=?").bind(
			count * 10000,
			market.id,
		),
	]);
	return market;
}
async function matchingFixture(count = 80) {
	const store = new Database(env.DB);
	const m = await store.createMarket({
		guildId: "741",
		creatorId: "742",
		oracleUserId: "742",
		description: "Matching budget",
		outcomeDescriptions: ["Yes", "No"],
	});
	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO users(discord_id,balance_units,locked_units) SELECT value,100000,CASE WHEN key<? THEN 6000 ELSE 0 END FROM json_each(?)",
		).bind(count, JSON.stringify(users)),
		env.DB.prepare(
			"INSERT INTO orders SELECT value,value,?,CASE WHEN key%2=0 THEN ? ELSE ? END,'buy',10000,6000,6000,0 FROM json_each(?) WHERE key<?",
		).bind(
			m.id,
			m.outcomes[0].id,
			m.outcomes[1].id,
			JSON.stringify(users),
			count,
		),
	]);
	return m;
}
async function commandRead(store: Database, id: string) {
	const m = await store.getMarket(id);
	expect(m?.guildId).toBe("741");
	expect(m?.oracleUserId).toBe("742");
}
async function snapshot(id: string) {
	return {
		market: await new Database(env.DB).getMarket(id),
		users: (
			await env.DB.prepare("SELECT * FROM users ORDER BY discord_id").all()
		).results,
		positions: (
			await env.DB.prepare("SELECT * FROM positions ORDER BY id").all()
		).results,
		orders: (await env.DB.prepare("SELECT * FROM orders ORDER BY id").all())
			.results,
		receipts: (
			await env.DB.prepare("SELECT * FROM operation_receipts ORDER BY id").all()
		).results,
		revision: await env.DB.prepare("SELECT * FROM revision").first(),
	};
}
async function conserved(id: string) {
	expect((await new Database(env.DB).getMarket(id))?.collateralUnits).toBe(0);
	expect(
		await env.DB.prepare(
			"SELECT sum(balance_units) AS balance,sum(locked_units) AS locked FROM users",
		).first<{ balance: number; locked: number }>(),
	).toEqual({ balance: 8800000, locked: 0 });
	expect(
		(
			await env.DB.prepare(
				"SELECT count(*) AS count FROM positions WHERE market_id=?",
			)
				.bind(id)
				.first()
		)?.count,
	).toBe(0);
}
beforeEach(async () => {
	for (const table of [
		"operation_receipts",
		"executions",
		"orders",
		"positions",
		"outcomes",
		"reactions",
		"markets",
		"users",
		"backfill_progress",
	])
		await env.DB.prepare(`DELETE FROM ${table}`).run();
	await env.DB.prepare("UPDATE revision SET version=0").run();
});
describe("constant set-based matching", () => {
	it("matches all 80 users, 80 deleted orders, positions and 40 execution receipts within one budget", async () => {
		const m = await matchingFixture();
		const trace = observed();
		const budget = new D1QueryBudget();
		const store = new Database(budget.wrap(trace.db));
		const result = await store.executeMarket(m.id, "80-match");
		expect(result.executions).toHaveLength(40);
		expect(budget.used).toBe(21);
		expect(trace.total).toBe(21);
		expect(trace.transportCalls).toBe(6);
		expect(trace.maxParameters).toBeLessThanOrEqual(100);
		expect((await new Database(env.DB).getMarket(m.id))?.collateralUnits).toBe(
			400000,
		);
		expect(
			await env.DB.prepare(
				"SELECT sum(balance_units) AS balance,sum(locked_units) AS locked FROM users",
			).first(),
		).toEqual({ balance: 7600000, locked: 0 });
		expect(await new Database(env.DB).getMarketOrders(m.id)).toEqual([]);
		expect(await store.executeMarket(m.id, "80-match")).toEqual(result);
		expect(budget.used).toBe(22);
	});
	it("actual order command creates the 80th order and applies all fills under 50 statements", async () => {
		const m = await matchingFixture(79);
		const trace = observed();
		const budget = new D1QueryBudget();
		const i: DiscordInteraction = {
			id: "900719925474099311",
			application_id: env.CLIENT_ID,
			token: "fake",
			type: 2,
			guild_id: "741",
			member: { user: { id: users[79] } },
			data: {
				name: "market",
				options: [
					{
						name: "order",
						type: 1,
						options: [
							{ name: "market", type: 3, value: m.id },
							{ name: "outcome", type: 3, value: m.outcomes[1].id },
							{ name: "direction", type: 3, value: "buy" },
							{ name: "quantity", type: 4, value: 1 },
							{ name: "price", type: 10, value: 0.6 },
						],
					},
				],
			},
		};
		expect(
			(await executeInteraction(i, { ...env, DB: budget.wrap(trace.db) }))
				.content,
		).toContain("Order");
		expect(budget.used).toBe(38);
		expect(trace.total).toBe(38);
		expect(await new Database(env.DB).getMarketOrders(m.id)).toEqual([]);
	});
	it("order command yields unaffordable match retry and resumes with the committed order receipt", async () => {
		const m = await matchingFixture(79);
		const trace = observed(async (batch, _, attempt) => {
			if (attempt === 2)
				await env.DB.prepare("UPDATE revision SET version=version+1").run();
			return batch;
		});
		const budget = new D1QueryBudget();
		const i: DiscordInteraction = {
			id: "900719925474099311",
			application_id: env.CLIENT_ID,
			token: "fake",
			type: 2,
			guild_id: "741",
			member: { user: { id: users[79] } },
			data: {
				name: "market",
				options: [
					{
						name: "order",
						type: 1,
						options: [
							{ name: "market", type: 3, value: m.id },
							{ name: "outcome", type: 3, value: m.outcomes[1].id },
							{ name: "direction", type: 3, value: "buy" },
							{ name: "quantity", type: 4, value: 1 },
							{ name: "price", type: 10, value: 0.6 },
						],
					},
				],
			},
		};
		await expect(
			executeInteraction(i, { ...env, DB: budget.wrap(trace.db) }),
		).rejects.toBeInstanceOf(D1QueryBudgetExceeded);
		expect(budget.used).toBe(44);
		expect(trace.total).toBe(44);
		expect(await new Database(env.DB).getMarketOrders(m.id)).toHaveLength(80);
		const next = new D1QueryBudget();
		expect(
			(await executeInteraction(i, { ...env, DB: next.wrap(env.DB) })).content,
		).toContain("Order");
		expect(next.used).toBe(23);
		expect(await new Database(env.DB).getMarketOrders(m.id)).toEqual([]);
	});

	it("matching response loss recovers 40 execution records without a second fill", async () => {
		const m = await matchingFixture();
		let lost = true;
		const trace = observed(undefined, () => {
			if (lost) {
				lost = false;
				throw new Error("lost matching response");
			}
		});
		const budget = new D1QueryBudget();
		const result = await new Database(budget.wrap(trace.db)).executeMarket(
			m.id,
			"lost-match",
		);
		expect(result.executions).toHaveLength(40);
		expect(budget.used).toBe(23);
		expect(
			(
				await env.DB.prepare(
					"SELECT count(*) AS count FROM executions WHERE market_id=?",
				)
					.bind(m.id)
					.first()
			)?.count,
		).toBe(40);
		expect((await new Database(env.DB).getMarket(m.id))?.collateralUnits).toBe(
			400000,
		);
	});

	it("both bulk delete and bulk partial update keep exact remaining escrow", async () => {
		const m = await matchingFixture();
		await env.DB.batch([
			env.DB.prepare(
				"UPDATE orders SET quantity_units=410000,escrow_units=246000 WHERE user_id=?",
			).bind(users[0]),
			env.DB.prepare(
				"UPDATE users SET balance_units=500000,locked_units=246000 WHERE discord_id=?",
			).bind(users[0]),
		]);
		const budget = new D1QueryBudget();
		await new Database(budget.wrap(env.DB)).executeMarket(m.id, "partial");
		expect(budget.used).toBe(23);
		const order = await new Database(env.DB).getOrder(users[0], m.id);
		expect(order?.quantityUnits).toBe(10000);
		expect(order?.escrowUnits).toBe(6000);
		expect((await new Database(env.DB).getBalance(users[0])).lockedUnits).toBe(
			6000,
		);
	});
	it("missing affected balance or a late trigger failure rolls back the whole captured matching operation", async () => {
		const m = await matchingFixture();
		const before = await snapshot(m.id);
		const trace = observed(async (batch, specs) =>
			batch.map((s, n) =>
				specs[n].sql.includes("WITH updates AS") &&
				specs[n].sql.includes("UPDATE users")
					? env.DB.prepare(
							specs[n].sql.replace(
								"WHERE discord_id IN",
								`WHERE discord_id!='${users[0]}' AND discord_id IN`,
							),
						).bind(...specs[n].values)
					: s,
			),
		);
		await expect(
			new Database(trace.db).executeMarket(m.id, "missing-match"),
		).rejects.toThrow();
		expect(await snapshot(m.id)).toEqual(before);
		await env.DB.prepare(
			`CREATE TRIGGER fail_matching BEFORE INSERT ON positions WHEN NEW.user_id='${users[79]}' BEGIN SELECT RAISE(ABORT,'injected trigger'); END`,
		).run();
		await expect(
			new Database(env.DB).executeMarket(m.id, "trigger-match"),
		).rejects.toThrow("injected trigger");
		expect(await snapshot(m.id)).toEqual(before);
		await env.DB.prepare("DROP TRIGGER fail_matching").run();
	});
});
describe("constant atomic settlement under conservative Free D1 statement budget", () => {
	it("settles all 80 affected users including command reads with one bound JSON parameter", async () => {
		const m = await fixture();
		const trace = observed();
		const budget = new D1QueryBudget();
		const store = new Database(budget.wrap(trace.db));
		await commandRead(store, m.id);
		const result = await store.resolveMarket(m.id, m.outcomes[0].id, "settle");
		expect(result?.winnerCount).toBe(80);
		expect(result?.totalPayoutUnits).toBe(800000);
		expect(trace.total).toBe(budget.used);
		expect(budget.used).toBe(17);
		expect(trace.maxParameters).toBeLessThanOrEqual(100);
		expect(trace.transportCalls).toBe(7);
		await conserved(m.id);
	});
	it("actual deferred resolve command includes authorization reads and replays without another payout", async () => {
		const m = await fixture();
		const trace = observed();
		const budget = new D1QueryBudget();
		const i: DiscordInteraction = {
			id: "900719925474099310",
			type: 3,
			application_id: env.CLIENT_ID,
			token: "fake",
			guild_id: "741",
			member: { user: { id: "742" } },
			data: { custom_id: `market:resolve:${m.id}`, values: [m.outcomes[0].id] },
		};
		const result = await executeInteraction(i, {
			...env,
			DB: budget.wrap(trace.db),
		});
		expect(result.content).toContain("resolved");
		expect(budget.used).toBe(17);
		await executeInteraction(i, { ...env, DB: budget.wrap(trace.db) });
		expect(budget.used).toBe(18);
		await conserved(m.id);
	});
	it("receipt replay is one read; ID collision performs no additional effects", async () => {
		const m = await fixture();
		const trace = observed();
		const budget = new D1QueryBudget();
		const store = new Database(budget.wrap(trace.db));
		const first = await store.resolveMarket(m.id, m.outcomes[0].id, "receipt");
		const before = budget.used;
		expect(
			await store.resolveMarket(m.id, m.outcomes[0].id, "receipt"),
		).toEqual(first);
		expect(budget.used - before).toBe(1);
		await expect(
			store.resolveMarket(m.id, m.outcomes[1].id, "receipt"),
		).rejects.toThrow("different request");
		expect(budget.used - before).toBe(2);
		await conserved(m.id);
	});
	it("one stale revision collision retries entire batch within 50 with command reads", async () => {
		const m = await fixture();
		const trace = observed(async (batch, _, attempt) => {
			if (attempt === 1)
				await env.DB.prepare("UPDATE revision SET version=version+1").run();
			return batch;
		});
		const budget = new D1QueryBudget();
		const store = new Database(budget.wrap(trace.db));
		await commandRead(store, m.id);
		expect(
			(await store.resolveMarket(m.id, m.outcomes[0].id, "collision"))
				?.winnerCount,
		).toBe(80);
		expect(budget.used).toBe(34);
		expect(trace.total).toBe(34);
		await conserved(m.id);
	});
	it("continued contention yields before an unaffordable atomic batch, then retries in a fresh invocation", async () => {
		const m = await fixture();
		const trace = observed(async (batch) => {
			await env.DB.prepare("UPDATE revision SET version=version+1").run();
			return batch;
		});
		const budget = new D1QueryBudget();
		const store = new Database(budget.wrap(trace.db));
		await commandRead(store, m.id);
		await expect(
			store.resolveMarket(m.id, m.outcomes[0].id, "retry"),
		).rejects.toBeInstanceOf(D1QueryBudgetExceeded);
		expect(budget.used).toBeLessThanOrEqual(50);
		expect(trace.total).toBe(budget.used);
		expect((await new Database(env.DB).getMarket(m.id))?.status).toBe("open");
		expect(
			await env.DB.prepare("SELECT id FROM operation_receipts WHERE id=?")
				.bind("retry")
				.first(),
		).toBeNull();
		const next = new D1QueryBudget();
		expect(
			(
				await new Database(next.wrap(env.DB)).resolveMarket(
					m.id,
					m.outcomes[0].id,
					"retry",
				)
			)?.winnerCount,
		).toBe(80);
		await conserved(m.id);
	});
	it("late failure rolls back every user, escrow release, deletion, receipt and revision", async () => {
		const m = await fixture();
		const before = await snapshot(m.id);
		const trace = observed(async (batch) => [
			...batch,
			env.DB.prepare("INSERT INTO operation_assertions VALUES(0)"),
		]);
		await expect(
			new Database(trace.db).resolveMarket(m.id, m.outcomes[0].id, "failed"),
		).rejects.toThrow();
		expect(await snapshot(m.id)).toEqual(before);
	});
	it("affected-count guard aborts settlement when a projected user is skipped", async () => {
		const m = await fixture();
		const before = await snapshot(m.id);
		const trace = observed(async (batch, specs) =>
			batch.map((s, n) =>
				specs[n].sql.includes("WITH settlement AS")
					? env.DB.prepare(
							specs[n].sql.replace(
								"WHERE discord_id IN",
								`WHERE discord_id!='${users[0]}' AND discord_id IN`,
							),
						).bind(...specs[n].values)
					: s,
			),
		);
		await expect(
			new Database(trace.db).resolveMarket(m.id, m.outcomes[0].id, "missing"),
		).rejects.toThrow();
		expect(await snapshot(m.id)).toEqual(before);
	});
	it("per-user overflow constraint rejects and rolls back the entire set-based update", async () => {
		const m = await fixture();
		await env.DB.prepare("UPDATE users SET balance_units=? WHERE discord_id=?")
			.bind(Number.MAX_SAFE_INTEGER, users[0])
			.run();
		const before = await snapshot(m.id);
		await expect(
			new Database(env.DB).resolveMarket(m.id, m.outcomes[0].id, "overflow"),
		).rejects.toThrow();
		expect(await snapshot(m.id)).toEqual(before);
	});
	it("lost response after commit recovers receipt without repeating credits", async () => {
		const m = await fixture();
		let lost = true;
		const trace = observed(undefined, () => {
			if (lost) {
				lost = false;
				throw new Error("lost response");
			}
		});
		const budget = new D1QueryBudget();
		const store = new Database(budget.wrap(trace.db));
		await commandRead(store, m.id);
		expect(
			(await store.resolveMarket(m.id, m.outcomes[0].id, "lost"))?.winnerCount,
		).toBe(80);
		expect(budget.used).toBe(19);
		await conserved(m.id);
	});
	it("negative control: old 18-user shape exceeds conservative logical budget, not a hosted quota proof", async () => {
		const m = await fixture(18);
		const budget = new D1QueryBudget();
		const db = budget.wrap(env.DB);
		for (let n = 0; n < 6; n++)
			await db.prepare("SELECT version FROM revision").first();
		const before = await snapshot(m.id);
		const legacyShape = observed();
		for (let n = 0; n < 6; n++)
			await legacyShape.db.prepare("SELECT version FROM revision").first();
		await legacyShape.db.batch(
			Array.from({ length: 45 }, () =>
				legacyShape.db.prepare("SELECT version FROM revision"),
			),
		);
		expect(legacyShape.total).toBe(51);
		expect(legacyShape.transportCalls).toBe(7);
		const batch = Array.from({ length: 45 }, () =>
			db.prepare("SELECT version FROM revision"),
		);
		await expect(
			Promise.resolve().then(() => db.batch(batch)),
		).rejects.toBeInstanceOf(D1QueryBudgetExceeded);
		expect(budget.used).toBe(6);
		expect(await snapshot(m.id)).toEqual(before);
	});
});
