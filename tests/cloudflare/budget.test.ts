import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import {
	D1QueryBudget,
	D1QueryBudgetExceeded,
} from "../../src/cloudflare/d1-budget";

it("shares a logical SQL budget across reads, binds, writes and batches", async () => {
	const budget = new D1QueryBudget(6);
	const db = budget.wrap(env.DB);
	const select = db.prepare("SELECT ? AS value").bind(42);
	expect(budget.used).toBe(0);
	expect(await select.first("value")).toBe(42);
	expect((await select.all()).results).toEqual([{ value: 42 }]);
	expect(await select.raw()).toEqual([[42]]);
	await select.run();
	await db.batch([select, select]);
	expect(budget.used).toBe(6);
	expect(budget.remaining).toBe(0);
	expect(() => select.all()).toThrow(D1QueryBudgetExceeded);
});

it("refuses an oversized batch before any mutation and permits a fresh invocation", async () => {
	const id = crypto.randomUUID();
	const budget = new D1QueryBudget(2);
	const db = budget.wrap(env.DB);
	await db.prepare("SELECT 1").all();
	const insert = db
		.prepare(
			"INSERT INTO users(discord_id,balance_units,locked_units) VALUES(?,0,0)",
		)
		.bind(id);
	expect(() => db.batch([insert, db.prepare("SELECT 1")])).toThrow(
		D1QueryBudgetExceeded,
	);
	expect(budget.used).toBe(1);
	expect(
		await env.DB.prepare("SELECT discord_id FROM users WHERE discord_id=?")
			.bind(id)
			.first(),
	).toBeNull();
	const fresh = new D1QueryBudget().wrap(env.DB);
	await fresh.batch([
		fresh
			.prepare(
				"INSERT INTO users(discord_id,balance_units,locked_units) VALUES(?,0,0)",
			)
			.bind(id),
		fresh.prepare("SELECT 1"),
	]);
	expect(
		await fresh
			.prepare("SELECT discord_id FROM users WHERE discord_id=?")
			.bind(id)
			.first("discord_id"),
	).toBe(id);
});

it("counts failed SQL attempts and prevents unbudgeted exec/session bypasses", async () => {
	const budget = new D1QueryBudget(2);
	const db = budget.wrap(env.DB);
	await expect(
		db.prepare("SELECT * FROM missing_table").all(),
	).rejects.toThrow();
	expect(budget.used).toBe(1);
	expect(() => db.exec("SELECT 1;SELECT 2")).toThrow("prepared statements");
	expect(() => db.withSession()).toThrow("sessions");
	await db.prepare("SELECT 1").all();
	expect(() => db.prepare("SELECT 1").all()).toThrow(D1QueryBudgetExceeded);
});
