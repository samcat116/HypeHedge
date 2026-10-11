import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import {
	D1QueryBudget,
	D1QueryBudgetExceeded,
} from "../../src/cloudflare/d1-budget";
import { Database } from "../../src/database";

const expected = Array.from({ length: 120 }, (_, i) => i + 1);
beforeAll(async () => {
	await env.DB.prepare(
		"INSERT INTO users(discord_id,balance_units,locked_units) VALUES('reader',1000000,600000),('holder',0,0)",
	).run();
	await env.DB.prepare(
		"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<120) INSERT INTO markets(id,number,guild_id,creator_id,description,oracle_user_id,created_at) SELECT 'read-'||i,i,CASE WHEN i%3=0 THEN 'other' ELSE 'guild' END,'creator','Market '||i,'oracle',1000+i FROM n",
	).run();
	await env.DB.prepare(
		"INSERT INTO outcomes(id,market_id,number,description) SELECT id||'-yes',id,1,'Yes' FROM markets UNION ALL SELECT id||'-no',id,2,'No' FROM markets",
	).run();
	await env.DB.prepare(
		"UPDATE markets SET status='resolved',winning_outcome_id=id||'-yes',resolved_at=2000 WHERE number%5=0",
	).run();
	await env.DB.prepare(
		"INSERT INTO orders(id,user_id,market_id,outcome_id,direction,quantity_units,price_units,escrow_units,created_at) SELECT 'order-'||id,'reader',id,id||'-yes','buy',10000,5000,5000,3000+number FROM markets",
	).run();
	await env.DB.prepare(
		"INSERT INTO positions(id,user_id,market_id,holdings,created_at,updated_at) SELECT 'position-'||id,'reader',id,json_object(id||'-no',20000),1000,2000 FROM markets WHERE number<=60",
	).run();
	await env.DB.prepare(
		"INSERT INTO positions(id,user_id,market_id,holdings,created_at,updated_at) VALUES('position-only','holder','read-1',json_object('read-1-yes',10000),1000,2000)",
	).run();
});
function reader() {
	const budget = new D1QueryBudget();
	return { budget, db: new Database(budget.wrap(env.DB)) };
}
it("100-market pages require two queries and preserve outcomes, status, count, dates and ordering", async () => {
	const { db, budget } = reader();
	const page = await db.getGuildMarketsPaginated("guild", 0, 100);
	expect(budget.used).toBe(2);
	expect(page.totalCount).toBe(80);
	expect(page.hasMore).toBe(false);
	expect(page.markets.map((m) => m.number)).toEqual(
		expected.filter((n) => n % 3 !== 0).reverse(),
	);
	for (const market of page.markets) {
		expect(
			market.outcomes.map((o) => [o.number, o.description, o.marketId]),
		).toEqual([
			[1, "Yes", market.id],
			[2, "No", market.id],
		]);
		expect(market.createdAt).toBeInstanceOf(Date);
	}
	const filtered = await db.getGuildMarketsPaginated("guild", 1, 10, "open");
	expect(budget.used).toBe(4);
	expect(filtered.totalCount).toBe(64);
	expect(filtered.hasMore).toBe(true);
	expect(filtered.markets.map((m) => m.number)).toEqual(
		expected
			.filter((n) => n % 3 !== 0 && n % 5 !== 0)
			.reverse()
			.slice(10, 20),
	);
	const empty = await db.getGuildMarketsPaginated("absent", 0, 100);
	expect(empty).toEqual({ markets: [], totalCount: 0, hasMore: false });
	expect(budget.used).toBe(6);
});
it("position and resting-order projections use one query for large collections and preserve guild scope", async () => {
	const { db, budget } = reader();
	const positions = await db.getUserPositions("reader", "guild");
	expect(budget.used).toBe(1);
	expect(positions).toHaveLength(80);
	expect(positions.map((p) => p.marketNumber)).toEqual(
		expected.filter((n) => n % 3 !== 0).reverse(),
	);
	for (const position of positions) {
		expect(position.holdings).toEqual(
			position.marketNumber <= 60 ? { [`${position.marketId}-no`]: 20000 } : {},
		);
		expect(position.order?.outcomeId).toBe(`${position.marketId}-yes`);
		expect(position.order?.quantityUnits).toBe(10000);
		expect(position.order?.escrowUnits).toBe(5000);
		expect(position.order?.createdAt).toBeInstanceOf(Date);
	}
	expect(await db.getUserPositions("holder", "guild")).toEqual([
		expect.objectContaining({
			marketId: "read-1",
			holdings: { "read-1-yes": 10000 },
			order: null,
		}),
	]);
	expect(budget.used).toBe(2);
	const markets = await db.getUserMarketsWithOrders("reader", "guild");
	expect(budget.used).toBe(3);
	expect(markets.map((m) => m.number)).toEqual(
		expected.filter((n) => n % 3 !== 0).reverse(),
	);
	expect(
		markets.every((m) => m.outcomes.length === 2 && m.guildId === "guild"),
	).toBe(true);
	expect(await db.getUserPositions("reader")).toHaveLength(120);
	expect(budget.used).toBe(4);
	expect(await db.getUserMarketsWithOrders("holder", "guild")).toEqual([]);
	expect(budget.used).toBe(5);
	expect(await db.getUserPositions("reader", "absent")).toEqual([]);
	expect(budget.used).toBe(6);
});
it("single-market and oracle reads retain complete projections without per-market D1 calls", async () => {
	const { db, budget } = reader();
	expect((await db.getMarket("read-1"))?.outcomes.map((o) => o.number)).toEqual(
		[1, 2],
	);
	expect(budget.used).toBe(1);
	expect((await db.getMarketByNumber("guild", 1))?.id).toBe("read-1");
	expect(budget.used).toBe(2);
	expect(await db.getMarketByNumber("other", 1)).toBeNull();
	expect(budget.used).toBe(3);
	const oracle = await db.getOracleOpenMarkets("guild", "oracle");
	expect(budget.used).toBe(4);
	expect(oracle).toHaveLength(64);
	expect(
		oracle.every(
			(m) =>
				m.status === "open" && m.guildId === "guild" && m.outcomes.length === 2,
		),
	).toBe(true);
});
it.each(["market-page", "positions", "resting-markets"] as const)(
	"pre-fix %s fan-out exceeds the conservative logical statement budget in local workerd",
	async (kind) => {
		const budget = new D1QueryBudget();
		const wrapped = budget.wrap(env.DB);
		const db = new Database(wrapped);
		const previous = async () => {
			if (kind === "market-page") {
				const rows = await wrapped
					.prepare(
						"SELECT id FROM markets WHERE guild_id=? ORDER BY number DESC LIMIT 100",
					)
					.bind("guild")
					.all<{ id: string }>();
				await wrapped
					.prepare("SELECT count(*) FROM markets WHERE guild_id=?")
					.bind("guild")
					.all();
				for (const market of rows.results) await db.getMarket(market.id);
			}
			if (kind === "positions") {
				const rows = await wrapped
					.prepare(
						"SELECT id FROM markets WHERE guild_id=? AND id IN(SELECT market_id FROM positions WHERE user_id=? UNION SELECT market_id FROM orders WHERE user_id=?)",
					)
					.bind("guild", "reader", "reader")
					.all<{ id: string }>();
				for (const market of rows.results)
					await db.getOrder("reader", market.id);
			}
			if (kind === "resting-markets") {
				const orders = await db.getUserOrders("reader");
				for (const order of orders) await db.getMarket(order.marketId);
			}
		};
		await expect(previous()).rejects.toBeInstanceOf(D1QueryBudgetExceeded);
		expect(budget.used).toBe(50);
	},
);
