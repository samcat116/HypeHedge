import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Database } from "../../src/database.js";
const store = new Database(env.DB);
async function fund(id: string, n = 10) {
	for (let i = 0; i < n; i++)
		await store.addReaction(`${id}-${i}`, "reactor", id, "x");
}
async function fixture() {
	await fund("buyer");
	await fund("seller");
	return store.createMarket({
		guildId: "guild",
		creatorId: "creator",
		oracleUserId: "oracle",
		description: "Does it happen?",
		outcomeDescriptions: ["Yes", "No"],
	});
}
async function invariant() {
	const rows = await env.DB.prepare(
		"SELECT u.discord_id FROM users u WHERE u.locked_units!=(SELECT COALESCE(sum(escrow_units),0) FROM orders WHERE user_id=u.discord_id) OR u.balance_units<u.locked_units",
	).all();
	expect(rows.results).toEqual([]);
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
describe("D1 atomic ledger in workerd", () => {
	it("allows existing holders to sell and reorder at the participant cap but rejects a new participant", async () => {
		const market = await fixture();
		const yes = market.outcomes[0].id;
		const no = market.outcomes[1].id;
		await store.createOrder("buyer", market.id, yes, "buy", 1, 5000);
		await store.createOrder("seller", market.id, no, "buy", 1, 5000);
		await store.executeMarket(market.id);
		expect(await store.getOrder("buyer", market.id)).toBeNull();
		for (let n = 0; n < 78; n++) {
			const user = `participant-${n}`;
			await fund(user, 1);
			expect(
				(await store.createOrder(user, market.id, yes, "buy", 1, 100)).success,
			).toBe(true);
		}
		expect(
			(await store.createOrder("buyer", market.id, yes, "sell", 1, 9000))
				.success,
		).toBe(true);
		expect((await store.cancelOrder("buyer", market.id)).success).toBe(true);
		expect(
			(await store.createOrder("buyer", market.id, no, "buy", 1, 100)).success,
		).toBe(true);
		await fund("new-participant", 1);
		expect(
			await store.createOrder("new-participant", market.id, yes, "buy", 1, 100),
		).toEqual({ success: false, error: "Market participant limit reached" });
		expect((await store.getBalance("new-participant")).lockedUnits).toBe(0);
		await invariant();
	});

	it("funds complete synthetic baskets with exact integer remainder allocation", async () => {
		await fund("buyer");
		await fund("seller");
		const m = await store.createMarket({
			guildId: "g",
			creatorId: "c",
			oracleUserId: "o",
			description: "Three outcomes",
			outcomeDescriptions: ["A", "B", "C"],
		});
		await store.createOrder("buyer", m.id, m.outcomes[0].id, "buy", 3, 7000);
		await store.createOrder("seller", m.id, m.outcomes[1].id, "buy", 3, 5000);
		expect((await store.executeMarket(m.id)).executions).toHaveLength(1);
		expect((await store.getMarket(m.id))?.collateralUnits).toBe(30000);
		for (const o of m.outcomes) {
			const total =
				((await store.getPosition("buyer", m.id))?.holdings[o.id] ?? 0) +
				((await store.getPosition("seller", m.id))?.holdings[o.id] ?? 0);
			expect(total).toBe(30000);
		}
		await store.resolveMarket(m.id, m.outcomes[2].id);
		expect(
			(await store.getBalance("buyer")).balanceUnits +
				(await store.getBalance("seller")).balanceUnits,
		).toBe(200000);
		await invariant();
	});
	it("failure before commit leaves no receipt or reservation and retry succeeds", async () => {
		const m = await fixture();
		const broken = new Database({
			prepare: env.DB.prepare.bind(env.DB),
			batch: async () => {
				throw new Error("injected before commit");
			},
		} as unknown as D1Database);
		await expect(
			broken.createOrder(
				"buyer",
				m.id,
				m.outcomes[0].id,
				"buy",
				1,
				6000,
				"uncommitted",
			),
		).rejects.toThrow("injected");
		expect(await store.getOrder("buyer", m.id)).toBeNull();
		expect((await store.getBalance("buyer")).lockedUnits).toBe(0);
		expect(
			(
				await store.createOrder(
					"buyer",
					m.id,
					m.outcomes[0].id,
					"buy",
					1,
					6000,
					"uncommitted",
				)
			).success,
		).toBe(true);
		await invariant();
	});

	it("includes resting-order-only markets in positions and scopes to guild", async () => {
		const m = await fixture();
		await store.createOrder("buyer", m.id, m.outcomes[0].id, "buy", 1, 6000);
		const rows = await store.getUserPositions("buyer", "guild");
		expect(rows).toHaveLength(1);
		expect(rows[0].holdings).toEqual({});
		expect(rows[0].order?.escrowUnits).toBe(6000);
		expect(await store.getUserPositions("buyer", "other-guild")).toEqual([]);
	});

	it.each([0, 1])(
		"funds short baskets and conserves total currency with winner %s",
		async (winner) => {
			const m = await fixture();
			const yes = m.outcomes[0].id;
			await store.createOrder("buyer", m.id, yes, "buy", 2, 6000, "buy");
			await store.createOrder("seller", m.id, yes, "sell", 2, 4000, "sell");
			const fill = await store.executeMarket(m.id, "fill");
			expect(fill.executions).toHaveLength(1);
			expect(await store.executeMarket(m.id, "fill")).toEqual(fill);
			expect((await store.getMarket(m.id))?.collateralUnits).toBe(20000);
			expect((await store.getPosition("seller", m.id))?.holdings).toEqual({
				[m.outcomes[1].id]: 20000,
			});
			await invariant();
			const settled = await store.resolveMarket(
				m.id,
				m.outcomes[winner].id,
				"resolve",
			);
			expect(settled?.totalPayoutUnits).toBe(20000);
			expect(
				(await store.resolveMarket(m.id, m.outcomes[winner].id, "resolve"))
					?.totalPayoutUnits,
			).toBe(20000);
			expect(
				await store.resolveMarket(m.id, m.outcomes[winner].id, "different"),
			).toBeNull();
			expect(
				(await store.getBalance("buyer")).balanceUnits +
					(await store.getBalance("seller")).balanceUnits,
			).toBe(200000);
			await invariant();
		},
	);
	it("serializes cross-market reservations sharing a global balance", async () => {
		await fund("buyer", 1);
		const params = {
			guildId: "guild",
			creatorId: "creator",
			oracleUserId: "oracle",
			description: "Market",
			outcomeDescriptions: ["Y", "N"],
		};
		const a = await store.createMarket(params);
		const b = await store.createMarket(params);
		const results = await Promise.all([
			store.createOrder("buyer", a.id, a.outcomes[0].id, "buy", 1, 6000, "a"),
			store.createOrder("buyer", b.id, b.outcomes[0].id, "buy", 1, 6000, "b"),
		]);
		expect(results.filter((r) => r.success)).toHaveLength(1);
		expect(results.find((r) => !r.success)?.error).toContain(
			"Insufficient balance",
		);
		expect((await store.getBalance("buyer")).lockedUnits).toBe(6000);
		await invariant();
	});
	it("concurrent fill/cancel/settlement leaves complete operations only", async () => {
		const m = await fixture();
		await store.createOrder("buyer", m.id, m.outcomes[0].id, "buy", 2, 6000);
		await store.createOrder("seller", m.id, m.outcomes[0].id, "sell", 2, 4000);
		await Promise.all([
			store.executeMarket(m.id, "fill"),
			store.cancelOrder("buyer", m.id, "cancel"),
			store.resolveMarket(m.id, m.outcomes[0].id, "settle"),
		]);
		expect((await store.getMarket(m.id))?.status).toBe("resolved");
		expect(await store.getMarketOrders(m.id)).toEqual([]);
		expect(
			(await store.getBalance("buyer")).balanceUnits +
				(await store.getBalance("seller")).balanceUnits,
		).toBe(200000);
		await invariant();
	});
	it("concurrent matching applies one captured fill", async () => {
		const m = await fixture();
		await store.createOrder("buyer", m.id, m.outcomes[0].id, "buy", 2, 6000);
		await store.createOrder("seller", m.id, m.outcomes[0].id, "sell", 2, 4000);
		const r = await Promise.all([
			store.executeMarket(m.id, "one"),
			store.executeMarket(m.id, "two"),
		]);
		expect(r.flatMap((x) => x.executions)).toHaveLength(1);
		expect((await store.getMarket(m.id))?.collateralUnits).toBe(20000);
		await invariant();
	});
	it("retains partial order locks and releases cancellation exactly once", async () => {
		const m = await fixture();
		await store.createOrder("buyer", m.id, m.outcomes[0].id, "buy", 3, 6000);
		await store.createOrder("seller", m.id, m.outcomes[0].id, "sell", 1, 4000);
		await store.executeMarket(m.id);
		expect((await store.getOrder("buyer", m.id))?.escrowUnits).toBe(12000);
		await store.cancelOrder("buyer", m.id, "cancel");
		await store.cancelOrder("buyer", m.id, "cancel");
		expect((await store.getBalance("buyer")).lockedUnits).toBe(0);
		await invariant();
	});
	it("reaction add/remove/add never mints extra credit when an award is locked", async () => {
		await store.addReaction("message", "reactor", "author", "x", "add1");
		const m = await store.createMarket({
			guildId: "g",
			creatorId: "c",
			oracleUserId: "o",
			description: "M",
			outcomeDescriptions: ["Y", "N"],
		});
		await store.createOrder("author", m.id, m.outcomes[0].id, "buy", 1, 6000);
		expect(
			await store.removeReaction("message", "reactor", "x", "remove"),
		).toBe(true);
		expect(
			await store.removeReaction("message", "reactor", "x", "remove"),
		).toBe(true);
		expect((await store.getBalance("author")).balanceUnits).toBe(6000);
		await store.addReaction("message", "reactor", "author", "x", "add2");
		expect((await store.getBalance("author")).balanceUnits).toBe(10000);
		await store.removeReaction("message", "reactor", "x", "remove2");
		await store.cancelOrder("author", m.id);
		await store.addReaction("message", "reactor", "author", "x", "add3");
		expect((await store.getBalance("author")).balanceUnits).toBe(10000);
		await invariant();
	});
	it("spent award removal/readd preserves outstanding credit", async () => {
		const m = await fixture();
		await store.createOrder("buyer", m.id, m.outcomes[0].id, "buy", 10, 6000);
		await store.createOrder("seller", m.id, m.outcomes[0].id, "sell", 10, 4000);
		await store.executeMarket(m.id);
		for (let i = 0; i < 10; i++)
			await store.removeReaction(`buyer-${i}`, "reactor", "x");
		expect((await store.getBalance("buyer")).balanceUnits).toBe(0);
		for (let i = 0; i < 10; i++)
			await store.addReaction(`buyer-${i}`, "reactor", "buyer", "x");
		expect((await store.getBalance("buyer")).balanceUnits).toBe(50000);
		expect((await store.getMarket(m.id))?.collateralUnits).toBe(100000);
	});
	it("rolls back earlier SQL effects on zero-row guards and late constraints", async () => {
		await fund("user", 1);
		await expect(
			env.DB.batch([
				env.DB.prepare(
					"UPDATE users SET balance_units=20000 WHERE discord_id=?",
				).bind("user"),
				env.DB.prepare(
					"UPDATE revision SET version=version+1 WHERE id=1 AND version=-1",
				),
				env.DB.prepare(
					"INSERT INTO operation_assertions SELECT CASE WHEN changes()=1 THEN 1 ELSE 0 END",
				),
			]),
		).rejects.toThrow();
		expect((await store.getBalance("user")).balanceUnits).toBe(10000);
		await expect(
			env.DB.batch([
				env.DB.prepare(
					"UPDATE users SET balance_units=20000 WHERE discord_id=?",
				).bind("user"),
				env.DB.prepare(
					"UPDATE users SET locked_units=30000 WHERE discord_id=?",
				).bind("user"),
			]),
		).rejects.toThrow();
		expect((await store.getBalance("user")).balanceUnits).toBe(10000);
	});
	it("rejects unsafe numbers, malformed holdings and mismatched receipt reuse", async () => {
		const m = await fixture();
		for (const q of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			1.5,
			-1,
			Number.MAX_SAFE_INTEGER,
		])
			expect(
				(
					await store.createOrder(
						"buyer",
						m.id,
						m.outcomes[0].id,
						"buy",
						q,
						5000,
					)
				).success,
			).toBe(false);
		await expect(
			env.DB.prepare("UPDATE users SET balance_units=9007199254740992").run(),
		).rejects.toThrow();
		await expect(
			env.DB.prepare("INSERT INTO positions VALUES(?,?,?,?,?,?)")
				.bind(
					"p",
					"buyer",
					m.id,
					JSON.stringify({ [m.outcomes[0].id]: -1 }),
					0,
					0,
				)
				.run(),
		).rejects.toThrow();
		await store.addReaction("m", "r", "buyer", "x", "same");
		await expect(
			store.addReaction("other", "r", "buyer", "x", "same"),
		).rejects.toThrow("different request");
	});
	it("replays after committed response loss without duplicate effects", async () => {
		const m = await fixture();
		const real = env.DB.batch.bind(env.DB);
		let lost = true;
		const flaky = new Database({
			prepare: env.DB.prepare.bind(env.DB),
			batch: async (statements: D1PreparedStatement[]) => {
				const r = await real(statements);
				if (lost) {
					lost = false;
					throw new Error("response lost");
				}
				return r;
			},
		} as unknown as D1Database);
		const result = await flaky.createOrder(
			"buyer",
			m.id,
			m.outcomes[0].id,
			"buy",
			1,
			6000,
			"lost",
		);
		expect(result.success).toBe(true);
		expect((await store.getBalance("buyer")).lockedUnits).toBe(6000);
		expect(await store.getUserOrders("buyer")).toHaveLength(1);
		await invariant();
	});
});
