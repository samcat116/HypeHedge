import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { Database } from "../../src/database";
// biome-ignore lint/suspicious/noExplicitAny: Crash injection observes private durable workflow state.
type Value = any;
function gateway() {
	return env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
}
function create(origin: number, guild: string) {
	return {
		id: ((BigInt(origin - 1420070400000) << 22n) + 12n).toString(),
		application_id: env.CLIENT_ID,
		token: "expiry-token",
		type: 5,
		guild_id: guild,
		user: { id: "881002" },
		data: {
			custom_id: "market:create:binary",
			components: [
				{
					type: 1,
					components: [
						{ type: 4, custom_id: "description", value: "Expiry prediction" },
					],
				},
			],
		},
	};
}
async function inside(
	stub: DurableObjectStub,
	fn: (instance: Value, state: DurableObjectState) => Promise<void>,
) {
	await (
		runInDurableObject as unknown as (
			stub: DurableObjectStub,
			fn: (instance: Value, state: DurableObjectState) => Promise<void>,
		) => Promise<void>
	)(stub, fn);
}
async function admit(stub: DurableObjectStub, input: Value) {
	const response = await stub.fetch("https://gateway/commands", {
		method: "POST",
		body: JSON.stringify(input),
	});
	return { status: response.status, body: await response.json<Value>() };
}
async function tick(stub: DurableObjectStub) {
	await inside(stub, async (instance, state) => {
		for (const [key, job] of await state.storage.list<Value>({
			prefix: "job:",
		})) {
			job.due = 0;
			await state.storage.put(key, job);
		}
		await instance.alarm();
	});
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
it.each([-1, 0, 1])(
	"gates new mutations at 14-minute execution cutoff offset %i ms",
	async (offset) => {
		const stub = gateway();
		const origin = Date.now();
		const input = create(origin, `88110${offset + 1}`);
		const clock = vi.spyOn(Date, "now").mockReturnValue(origin);
		const fetch = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetch);
		expect((await admit(stub, input)).body.state).toBe("pending");
		clock.mockReturnValue(origin + 14 * 60000 + offset);
		await tick(stub);
		const count = (
			await env.DB.prepare("SELECT id FROM markets WHERE guild_id=?")
				.bind(input.guild_id)
				.all()
		).results.length;
		expect(count).toBe(offset < 0 ? 1 : 0);
		const completed = (await admit(stub, input)).body;
		expect(completed.state).toBe("completed");
		if (offset >= 0) {
			expect(completed.payload.content).toContain("expired before execution");
			await inside(stub, async (_, state) => {
				expect(
					await state.storage.get(`job:command:${input.id}`),
				).toBeUndefined();
				expect(
					(await state.storage.get<Value>(`seen:command:${input.id}`)).delivery,
				).toBe("expired");
			});
		}
		await evictDurableObject(stub);
		expect((await admit(stub, input)).body).toEqual(completed);
		expect(fetch).not.toHaveBeenCalled();
	},
);
it("expired unstarted reset cannot replace existing scan", async () => {
	const stub = gateway();
	const origin = Date.now();
	const base = create(origin, "881201");
	const input = {
		...base,
		type: 2,
		member: { user: { id: "881002" }, permissions: "8" },
		data: {
			name: "backfill",
			options: [{ name: "reset", type: 5, value: true }],
		},
	};
	const clock = vi.spyOn(Date, "now").mockReturnValue(origin);
	await admit(stub, input);
	await inside(stub, async (_, state) => {
		await state.storage.put("job:backfill:881201", {
			kind: "backfill",
			id: "backfill:881201",
			data: {
				scanId: "prior",
				guildId: "881201",
				channelIndex: 0,
				limit: 100,
				scanned: 0,
			},
			attempts: 0,
			due: origin + 86400000,
		});
	});
	clock.mockReturnValue(origin + 14 * 60000);
	await inside(stub, async (instance) => {
		await instance.alarm();
	});
	await inside(stub, async (_, state) => {
		expect(
			(await state.storage.get<Value>("job:backfill:881201")).data.scanId,
		).toBe("prior");
		expect(
			await state.storage.get(`backfill-admission:${input.id}`),
		).toBeUndefined();
	});
	expect((await admit(stub, input)).body.payload.content).toContain(
		"expired before execution",
	);
});
it("durable timely start survives crash before first mutation and authorizes continuation after expiry", async () => {
	const stub = gateway();
	const origin = Date.now();
	const input = create(origin, "881301");
	const clock = vi.spyOn(Date, "now").mockReturnValue(origin);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 204 })),
	);
	await admit(stub, input);
	await inside(stub, async (instance, state) => {
		const original = instance.startCommand.bind(instance);
		instance.startCommand = async (...args: Value[]) => {
			await original(...args);
			throw new Error("Crash after durable start");
		};
		await instance.alarm();
		expect(
			(await state.storage.get<Value>(`job:command:${input.id}`)).startedAt,
		).toBe(origin);
	});
	expect(
		(
			await env.DB.prepare(
				"SELECT id FROM markets WHERE guild_id='881301'",
			).all()
		).results,
	).toHaveLength(0);
	clock.mockReturnValue(origin + 15 * 60000);
	await evictDurableObject(stub);
	await tick(stub);
	expect(
		(
			await env.DB.prepare(
				"SELECT id FROM markets WHERE guild_id='881301'",
			).all()
		).results,
	).toHaveLength(1);
	expect((await admit(stub, input)).body.payload.content).toContain(
		"Expiry prediction",
	);
});
it("committed D1 response loss then outage resumes receipt after expiry without another mutation", async () => {
	const stub = gateway();
	const origin = Date.now();
	const input = create(origin, "881401");
	const clock = vi.spyOn(Date, "now").mockReturnValue(origin);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 204 })),
	);
	await admit(stub, input);
	await inside(stub, async (instance, state) => {
		const db = instance.env.DB as D1Database;
		let unavailable = false;
		const faultDB = new Proxy(db, {
			get(target, property) {
				if (property === "batch")
					return async (statements: D1PreparedStatement[]) => {
						await target.batch(statements);
						unavailable = true;
						throw new Error("Committed response lost");
					};
				if (property === "prepare")
					return (sql: string) => {
						if (unavailable)
							throw new Error("D1 unavailable during receipt recovery");
						return target.prepare(sql);
					};
				const value = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		instance.env = { ...instance.env, DB: faultDB };
		await instance.alarm();
		expect(
			(await state.storage.get<Value>(`job:command:${input.id}`)).kind,
		).toBe("command");
	});
	expect(
		(
			await env.DB.prepare(
				"SELECT id FROM markets WHERE guild_id='881401'",
			).all()
		).results,
	).toHaveLength(1);
	clock.mockReturnValue(origin + 15 * 60000);
	await evictDurableObject(stub);
	await tick(stub);
	expect(
		(
			await env.DB.prepare(
				"SELECT id FROM markets WHERE guild_id='881401'",
			).all()
		).results,
	).toHaveLength(1);
	expect((await admit(stub, input)).body.payload.content).toContain(
		"Expiry prediction",
	);
});
it("timely reserved order completes its separate matching receipt after expiry", async () => {
	const stub = gateway();
	const origin = Date.now();
	const db = new Database(env.DB);
	const market = await db.createMarket({
		guildId: "881501",
		creatorId: "881002",
		oracleUserId: "881002",
		description: "Order expiry",
		outcomeDescriptions: ["Yes", "No"],
	});
	await db.addReaction(
		"expiry-funds",
		"881003",
		"881002",
		"x",
		"expiry-funds-add",
	);
	const input = {
		...create(origin, "881501"),
		type: 2,
		data: {
			name: "market",
			options: [
				{
					name: "order",
					type: 1,
					options: [
						{ name: "market", type: 3, value: market.id },
						{ name: "outcome", type: 3, value: market.outcomes[0].id },
						{ name: "direction", type: 3, value: "buy" },
						{ name: "quantity", type: 4, value: 1 },
						{ name: "price", type: 10, value: 0.5 },
					],
				},
			],
		},
	};
	const clock = vi.spyOn(Date, "now").mockReturnValue(origin);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 204 })),
	);
	vi.spyOn(Database.prototype, "executeMarket").mockRejectedValueOnce(
		new Error("Budget/retry boundary after reservation"),
	);
	await admit(stub, input);
	await tick(stub);
	const receiptCount = async (suffix: string) =>
		(
			await env.DB.prepare("SELECT id FROM operation_receipts WHERE id=?")
				.bind(`interaction:${input.id}${suffix}`)
				.all()
		).results.length;
	expect(await receiptCount("")).toBe(1);
	expect(await receiptCount(":match")).toBe(0);
	expect((await db.getBalance("881002")).lockedUnits).toBe(5000);
	clock.mockReturnValue(origin + 15 * 60000);
	await evictDurableObject(stub);
	await tick(stub);
	expect(await receiptCount("")).toBe(1);
	expect(await receiptCount(":match")).toBe(1);
	expect(
		(
			await env.DB.prepare("SELECT id FROM orders WHERE market_id=?")
				.bind(market.id)
				.all()
		).results,
	).toHaveLength(1);
	expect((await db.getBalance("881002")).lockedUnits).toBe(5000);
	expect((await admit(stub, input)).body.payload.content).toContain(
		"Order placed",
	);
});
it("failed start-marker transaction cannot leak authorization into generic retry save", async () => {
	const stub = gateway();
	const origin = Date.now();
	const input = create(origin, "881601");
	const clock = vi.spyOn(Date, "now").mockReturnValue(origin);
	await admit(stub, input);
	await inside(stub, async (instance, state) => {
		const original = state.storage.transaction.bind(state.storage);
		const spy = vi
			.spyOn(state.storage, "transaction")
			.mockImplementation((callback: Value) =>
				original((tx) =>
					callback(
						new Proxy(tx, {
							get(target, property) {
								if (property === "put")
									return async (key: string, value: Value) => {
										if (value?.startedAt !== undefined)
											throw new Error("Start marker write failed");
										return target.put(key, value);
									};
								const value = Reflect.get(target, property);
								return typeof value === "function" ? value.bind(target) : value;
							},
						}),
					),
				),
			);
		try {
			await instance.alarm();
		} finally {
			spy.mockRestore();
		}
		expect(
			(await state.storage.get<Value>(`job:command:${input.id}`)).startedAt,
		).toBeUndefined();
	});
	clock.mockReturnValue(origin + 15 * 60000);
	await evictDurableObject(stub);
	await tick(stub);
	expect(
		(
			await env.DB.prepare(
				"SELECT id FROM markets WHERE guild_id='881601'",
			).all()
		).results,
	).toHaveLength(0);
	expect((await admit(stub, input)).body.payload.content).toContain(
		"expired before execution",
	);
});
