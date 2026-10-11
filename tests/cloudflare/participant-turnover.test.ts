import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { D1QueryBudget } from "../../src/cloudflare/d1-budget";
import { Database } from "../../src/database";
const ids = Array.from({ length: 200 }, (_, i) => String(900000 + i));
const store = new Database(env.DB);
async function market() {
	return store.createMarket({
		guildId: "guild",
		creatorId: "creator",
		oracleUserId: "oracle",
		description: "Participant turnover",
		outcomeDescriptions: ["Yes", "No"],
	});
}
async function users(count: number) {
	await env.DB.prepare(
		"INSERT INTO users(discord_id,balance_units) SELECT value,20000 FROM json_each(?)",
	)
		.bind(JSON.stringify(ids.slice(0, count)))
		.run();
}
async function zeros(
	m: Awaited<ReturnType<typeof market>>,
	count: number,
	start = 0,
) {
	await env.DB.prepare(
		"INSERT INTO positions SELECT value,value,?,CASE WHEN key%2=0 THEN '{}' ELSE json_object(?,0,?,0) END,0,0 FROM json_each(?)",
	)
		.bind(
			m.id,
			m.outcomes[0].id,
			m.outcomes[1].id,
			JSON.stringify(ids.slice(start, start + count)),
		)
		.run();
}
async function activeCount(id: string) {
	return (
		await env.DB.prepare(
			"SELECT count(*) AS count FROM (SELECT user_id FROM orders WHERE market_id=? UNION SELECT user_id FROM positions WHERE market_id=? AND EXISTS(SELECT 1 FROM json_each(positions.holdings) WHERE value>0))",
		)
			.bind(id, id)
			.first<{ count: number }>()
	)?.count;
}
async function locks() {
	expect(
		(
			await env.DB.prepare(
				"SELECT discord_id FROM users WHERE locked_units!=COALESCE((SELECT sum(escrow_units) FROM orders WHERE user_id=discord_id),0)",
			).all()
		).results,
	).toEqual([]);
}
async function positionRows(id: string) {
	return (
		await env.DB.prepare(
			"SELECT * FROM positions WHERE market_id=? ORDER BY user_id",
		)
			.bind(id)
			.all()
	).results;
}
function boundedReads() {
	let maximumPositionRows = 0;
	const db = new Proxy(env.DB, {
		get(target, key) {
			if (key === "prepare")
				return (sql: string) => {
					function wrap(s: D1PreparedStatement): D1PreparedStatement {
						return new Proxy(s, {
							get(t, k) {
								if (k === "bind")
									return (...values: unknown[]) => wrap(t.bind(...values));
								const fn = Reflect.get(t, k, t);
								if (k === "all")
									return async () => {
										const result = await t.all();
										if (
											sql.includes("SELECT * FROM positions WHERE market_id=")
										)
											maximumPositionRows = Math.max(
												maximumPositionRows,
												result.results.length,
											);
										return result;
									};
								return typeof fn === "function" ? fn.bind(t) : fn;
							},
						});
					}
					return wrap(target.prepare(sql));
				};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		db,
		get maximumPositionRows() {
			return maximumPositionRows;
		},
	};
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
describe("active participants survive historical turnover", () => {
	it("actually transfers the same share through 85 sold-out traders without consuming historical slots", async () => {
		const m = await market();
		await users(87);
		const [yes, no] = m.outcomes;
		expect(
			(await store.createOrder(ids[0], m.id, yes.id, "buy", 1, 5000)).success,
		).toBe(true);
		expect(
			(await store.createOrder(ids[86], m.id, no.id, "buy", 1, 5000)).success,
		).toBe(true);
		await store.executeMarket(m.id);
		for (let n = 1; n <= 85; n++) {
			expect(
				(
					await store.createOrder(
						ids[n - 1],
						m.id,
						yes.id,
						"sell",
						1,
						5000,
						`sell-${n}`,
					)
				).success,
			).toBe(true);
			expect(
				(
					await store.createOrder(
						ids[n],
						m.id,
						yes.id,
						"buy",
						1,
						5000,
						`buy-${n}`,
					)
				).success,
			).toBe(true);
			expect(
				(await store.executeMarket(m.id, `fill-${n}`)).executions,
			).toHaveLength(1);
			expect(await store.getPosition(ids[n - 1], m.id)).toBeNull();
			expect(await activeCount(m.id)).toBe(2);
			expect(await positionRows(m.id)).toHaveLength(2);
		}
		expect((await store.getMarket(m.id))?.collateralUnits).toBe(10000);
		expect(
			(
				await env.DB.prepare(
					"SELECT sum(balance_units) AS total FROM users",
				).first<{ total: number }>()
			)?.total,
		).toBe(1730000);
		await locks();
		await store.resolveMarket(m.id, yes.id, "settle-turnover");
		expect(
			(
				await env.DB.prepare(
					"SELECT sum(balance_units) AS total FROM users",
				).first<{ total: number }>()
			)?.total,
		).toBe(1740000);
	});
	it("historical {} and zero-entry rows do not block entrants or materialize in matching and settlement", async () => {
		const m = await market();
		await users(162);
		await zeros(m, 160, 2);
		// Negative control: old admission counts 160 historical users and rejects everyone.
		const legacy = (
			await env.DB.prepare(
				"SELECT count(*) AS count FROM (SELECT user_id FROM orders WHERE market_id=? UNION SELECT user_id FROM positions WHERE market_id=?)",
			)
				.bind(m.id, m.id)
				.first<{ count: number }>()
		)?.count;
		expect(legacy).toBe(160);
		expect(await activeCount(m.id)).toBe(0);
		expect(
			(await store.createOrder(ids[0], m.id, m.outcomes[0].id, "buy", 1, 5000))
				.success,
		).toBe(true);
		expect(
			(await store.createOrder(ids[1], m.id, m.outcomes[1].id, "buy", 1, 5000))
				.success,
		).toBe(true);
		const reads = boundedReads();
		const budget = new D1QueryBudget();
		await new Database(budget.wrap(reads.db)).executeMarket(
			m.id,
			"matching-history",
		);
		expect(reads.maximumPositionRows).toBe(0);
		expect(budget.used).toBe(21);
		expect(await positionRows(m.id)).toHaveLength(2);
		// Add historical empty records again to prove settlement independently filters them.
		await zeros(m, 160, 2);
		const settledReads = boundedReads();
		const settledBudget = new D1QueryBudget();
		const result = await new Database(
			settledBudget.wrap(settledReads.db),
		).resolveMarket(m.id, m.outcomes[0].id, "settlement-history");
		expect(settledReads.maximumPositionRows).toBe(2);
		expect(result?.payouts).toHaveLength(1);
		expect(settledBudget.used).toBe(16);
		expect(await positionRows(m.id)).toEqual([]);
		await locks();
	});
	it("an existing empty row cannot bypass 80 active participants but a positive holder can reorder", async () => {
		const m = await market();
		await users(162);
		await zeros(m, 82, 80);
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO positions SELECT value,value,?,json_object(?,10000,?,10000),0,0 FROM json_each(?)",
			).bind(
				m.id,
				m.outcomes[0].id,
				m.outcomes[1].id,
				JSON.stringify(ids.slice(0, 40)),
			),
			env.DB.prepare(
				"INSERT INTO orders SELECT value,value,?,?,'buy',10000,100,100,0 FROM json_each(?)",
			).bind(m.id, m.outcomes[0].id, JSON.stringify(ids.slice(40, 80))),
			env.DB.prepare(
				"UPDATE users SET locked_units=100 WHERE discord_id IN (SELECT value FROM json_each(?))",
			).bind(JSON.stringify(ids.slice(40, 80))),
			env.DB.prepare(
				"UPDATE markets SET collateral_units=400000 WHERE id=?",
			).bind(m.id),
		]);
		expect(await activeCount(m.id)).toBe(80);
		// Negative control: old exemption merely tests row existence and would admit both historical rows.
		expect(await store.getPosition(ids[80], m.id)).not.toBeNull();
		expect(await store.getPosition(ids[81], m.id)).not.toBeNull();
		for (const id of [ids[80], ids[81]])
			expect(
				await store.createOrder(
					id,
					m.id,
					m.outcomes[0].id,
					"buy",
					1,
					100,
					`inactive-${id}`,
				),
			).toEqual({ success: false, error: "Market participant limit reached" });
		expect(
			(
				await store.createOrder(
					ids[0],
					m.id,
					m.outcomes[0].id,
					"sell",
					1,
					9000,
					"holder",
				)
			).success,
		).toBe(true);
		expect(await activeCount(m.id)).toBe(80);
		await locks();
	});
	it("concurrent historical entrants compete for exactly one remaining active slot", async () => {
		const m = await market();
		await users(100);
		await zeros(m, 21, 79);
		await env.DB.batch([
			env.DB.prepare(
				"INSERT INTO orders SELECT value,value,?,?,'buy',10000,100,100,0 FROM json_each(?)",
			).bind(m.id, m.outcomes[0].id, JSON.stringify(ids.slice(0, 79))),
			env.DB.prepare(
				"UPDATE users SET locked_units=100 WHERE discord_id IN (SELECT value FROM json_each(?))",
			).bind(JSON.stringify(ids.slice(0, 79))),
		]);
		const results = await Promise.all([
			store.createOrder(
				ids[79],
				m.id,
				m.outcomes[0].id,
				"buy",
				1,
				100,
				"last-a",
			),
			store.createOrder(
				ids[80],
				m.id,
				m.outcomes[0].id,
				"buy",
				1,
				100,
				"last-b",
			),
		]);
		expect(results.filter((r) => r.success)).toHaveLength(1);
		expect(results.find((r) => !r.success)?.error).toBe(
			"Market participant limit reached",
		);
		expect(await activeCount(m.id)).toBe(80);
		await locks();
	});
	it("one positive unit counts as active and zero-only markets disappear from position views", async () => {
		const m = await market();
		await users(2);
		await zeros(m, 2);
		expect(await store.getUserPositions(ids[0], "guild")).toEqual([]);
		await env.DB.prepare(
			"UPDATE positions SET holdings=json_object(?,0,?,1) WHERE user_id=?",
		)
			.bind(m.outcomes[0].id, m.outcomes[1].id, ids[0])
			.run();
		expect(await activeCount(m.id)).toBe(1);
		expect(await store.getUserPositions(ids[0], "guild")).toHaveLength(1);
		await store.createOrder(ids[1], m.id, m.outcomes[0].id, "buy", 1, 100);
		const view = await store.getUserPositions(ids[1], "guild");
		expect(view).toHaveLength(1);
		expect(view[0].order?.escrowUnits).toBe(100);
	});
	it("empty-position cleanup is atomic with fills, receipts, revision and balances, and response-loss replay preserves deletion", async () => {
		const m = await market();
		await users(3);
		await store.createOrder(ids[0], m.id, m.outcomes[0].id, "buy", 1, 5000);
		await store.createOrder(ids[2], m.id, m.outcomes[1].id, "buy", 1, 5000);
		await store.executeMarket(m.id);
		await store.createOrder(ids[0], m.id, m.outcomes[0].id, "sell", 1, 5000);
		await store.createOrder(ids[1], m.id, m.outcomes[0].id, "buy", 1, 5000);
		const before = await positionRows(m.id);
		const revision = await env.DB.prepare(
			"SELECT version FROM revision",
		).first();
		const faulty = new Database(
			new Proxy(env.DB, {
				get(t, k) {
					if (k === "batch")
						return (batch: D1PreparedStatement[]) =>
							t.batch([
								...batch,
								t.prepare("INSERT INTO operation_assertions VALUES(0)"),
							]);
					const v = Reflect.get(t, k, t);
					return typeof v === "function" ? v.bind(t) : v;
				},
			}),
		);
		await expect(
			faulty.executeMarket(m.id, "cleanup-failed"),
		).rejects.toThrow();
		expect(await positionRows(m.id)).toEqual(before);
		expect(
			await env.DB.prepare("SELECT version FROM revision").first(),
		).toEqual(revision);
		expect(
			await env.DB.prepare("SELECT id FROM operation_receipts WHERE id=?")
				.bind("cleanup-failed")
				.first(),
		).toBeNull();
		await locks();
		let lost = true;
		const lostResponse = new Database(
			new Proxy(env.DB, {
				get(t, k) {
					if (k === "batch")
						return async (batch: D1PreparedStatement[]) => {
							const r = await t.batch(batch);
							if (lost) {
								lost = false;
								throw new Error("lost after cleanup");
							}
							return r;
						};
					const v = Reflect.get(t, k, t);
					return typeof v === "function" ? v.bind(t) : v;
				},
			}),
		);
		expect(
			(await lostResponse.executeMarket(m.id, "cleanup-lost")).executions,
		).toHaveLength(1);
		expect(await store.getPosition(ids[0], m.id)).toBeNull();
		expect(
			(await store.executeMarket(m.id, "cleanup-lost")).executions,
		).toHaveLength(1);
		expect(await activeCount(m.id)).toBe(2);
		await locks();
	});
});
