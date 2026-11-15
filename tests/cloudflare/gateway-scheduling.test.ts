import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { D1QueryBudget } from "../../src/cloudflare/d1-budget";
import { Database } from "../../src/database";
// biome-ignore lint/suspicious/noExplicitAny: Runtime failure injection inspects private durable JSON.
type Value = any;
function gateway() {
	return env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
}
async function inspect(
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
function command(id: string) {
	return {
		kind: "command",
		id: `command:${id}`,
		attempts: 0,
		due: 0,
		data: {
			id,
			application_id: "123",
			token: "fake",
			type: 2,
			user: { id: "fair-command-user" },
			data: { name: "balance" },
		},
	};
}
function reply(id: string) {
	return {
		kind: "reply",
		id: `reply:${id}`,
		attempts: 0,
		due: 0,
		data: {
			applicationId: "123",
			token: id,
			payload: { content: "delivered" },
			expiresAt: Date.now() + 600000,
		},
	};
}
function backfill(index: number) {
	return {
		kind: "backfill",
		id: `backfill:fair-${String(index).padStart(2, "0")}`,
		attempts: 0,
		due: 0,
		data: {
			guildId: `fair-${index}`,
			scanId: `fair-scan-${index}`,
			channelIds: [`fair-channel-${index}`],
			channelIndex: 0,
			limit: 1000,
			scanned: 0,
		},
	};
}
async function seedBackfills(stub: DurableObjectStub) {
	await inspect(stub, async (_, state) => {
		for (let index = 0; index < 16; index++) {
			const job = backfill(index);
			await state.storage.put(`job:${job.id}`, job);
		}
	});
}
async function drain(stub: DurableObjectStub) {
	await inspect(stub, async (instance, state) => {
		for (const [key, job] of await state.storage.list<Value>({
			prefix: "job:",
		})) {
			job.due = 0;
			await state.storage.put(key, job);
		}
		await instance.alarm();
	});
}
beforeEach(() =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Value) => {
			const url = new URL(String(input));
			if (url.pathname.includes("/webhooks/"))
				return new Response(null, { status: 204 });
			if (url.pathname.includes("/fair-live/"))
				return Response.json({
					author: { id: "fair-live-author", bot: false },
				});
			if (url.pathname.includes("/fair-channel-"))
				return Response.json([
					{ id: "backfill-bot-message", author: { id: "bot", bot: true } },
				]);
			throw new Error(url.href);
		}),
	),
);
afterEach(() => vi.unstubAllGlobals());

it("drains real commands, reaction effects and replies despite sixteen active backfills", async () => {
	const stub = gateway();
	await seedBackfills(stub);
	const id = (BigInt(Date.now() - 1420070400000) << 22n).toString();
	await inspect(stub, async (instance, state) => {
		const jobs = [
			command(id),
			reply("ready-reply"),
			{
				kind: "event",
				id: "event:0000000000000001:live",
				attempts: 0,
				due: 0,
				data: {
					op: 0,
					s: 1,
					t: "MESSAGE_REACTION_ADD",
					d: {
						guild_id: "fair-guild",
						channel_id: "fair-live",
						message_id: "fair-live-message",
						user_id: "fair-reactor",
						member: { user: { id: "fair-reactor", bot: false } },
						emoji: { name: "👍" },
					},
				},
			},
		];
		for (const job of jobs) await state.storage.put(`job:${job.id}`, job);
		await instance.alarm();
		expect((await state.storage.get<Value>(`job:command:${id}`)).kind).toBe(
			"reply",
		);
		expect(await state.storage.get("job:reply:ready-reply")).toBeUndefined();
		expect(
			await state.storage.get("job:event:0000000000000001:live"),
		).toBeUndefined();
		const progressed = [
			...(
				await state.storage.list<Value>({ prefix: "job:backfill:" })
			).values(),
		].filter((job) => job.data.scanned > 0);
		expect(progressed.length).toBeGreaterThan(0);
		expect(progressed.length + 3).toBeLessThanOrEqual(16);
	});
	expect(
		(await new Database(env.DB).getBalance("fair-live-author")).balanceUnits,
	).toBe(10000);
});
it("rotates all backfills under continuous interactive load across eviction", async () => {
	const stub = gateway();
	await seedBackfills(stub);
	for (let round = 0; round < 4; round++) {
		await inspect(stub, async (_, state) => {
			for (let i = 0; i < 16; i++) {
				const id = (
					(BigInt(Date.now() - 1420070400000) << 22n) +
					BigInt(round * 100 + i)
				).toString();
				const event = {
					kind: "event",
					id: `event:${String(round * 100 + i).padStart(16, "0")}`,
					attempts: 0,
					due: 0,
					data: {
						op: 0,
						t: "MESSAGE_REACTION_REMOVE",
						d: { emoji: { name: "👍" } },
					},
				};
				for (const job of [
					command(id),
					reply(`interactive-${round}-${i}`),
					event,
				])
					await state.storage.put(`job:${job.id}`, job);
			}
		});
		await drain(stub);
		if (round === 1) await evictDurableObject(stub);
	}
	await inspect(stub, async (_, state) => {
		const jobs = [
			...(
				await state.storage.list<Value>({ prefix: "job:backfill:" })
			).values(),
		];
		expect(jobs).toHaveLength(16);
		expect(jobs.every((job) => job.data.scanned >= 1)).toBe(true);
	});
});
it("blocks later reaction events behind a failed FIFO head while other work progresses", async () => {
	const stub = gateway();
	await seedBackfills(stub);
	await new Database(env.DB).addReaction(
		"fifo-message",
		"fifo-reactor",
		"fifo-author",
		"👍",
		"fifo-initial",
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Value) => {
			if (String(input).includes("/fifo-live/"))
				return new Response(null, { status: 503 });
			return Response.json([
				{ id: "bot-message", author: { id: "bot", bot: true } },
			]);
		}),
	);
	await inspect(stub, async (instance, state) => {
		for (let sequence = 1; sequence <= 2; sequence++) {
			const id = `event:${String(sequence).padStart(16, "0")}:fifo`;
			await state.storage.put(`job:${id}`, {
				kind: "event",
				id,
				attempts: 0,
				due: 0,
				data: {
					op: 0,
					s: sequence,
					t:
						sequence === 1 ? "MESSAGE_REACTION_ADD" : "MESSAGE_REACTION_REMOVE",
					d: {
						guild_id: "fifo-guild",
						channel_id: "fifo-live",
						message_id: "fifo-message",
						user_id: "fifo-reactor",
						emoji: { name: "👍" },
					},
				},
			});
		}
		await instance.alarm();
		expect(
			(await state.storage.get<Value>("job:event:0000000000000001:fifo"))
				.attempts,
		).toBe(1);
		expect(
			(await state.storage.get<Value>("job:event:0000000000000002:fifo"))
				.attempts,
		).toBe(0);
		expect(
			[
				...(
					await state.storage.list<Value>({ prefix: "job:backfill:" })
				).values(),
			].some((job) => job.data.scanned > 0),
		).toBe(true);
	});
	expect(
		(await new Database(env.DB).getBalance("fifo-author")).balanceUnits,
	).toBe(10000);
});
it("honors a global REST retry pause without draining any work", async () => {
	const stub = gateway();
	await seedBackfills(stub);
	await inspect(stub, async (instance, state) => {
		await state.storage.put("restPause", Date.now() + 60000);
		await instance.alarm();
		expect(
			[
				...(
					await state.storage.list<Value>({ prefix: "job:backfill:" })
				).values(),
			].every((job) => job.data.scanned === 0),
		).toBe(true);
	});
	expect(fetch).not.toHaveBeenCalled();
});

it.each([4004, 4010, 4011, 4012, 4013, 4014])(
	"disables reconnect after terminal Discord close %i",
	async (code) => {
		const stub = gateway();
		let server!: WebSocket;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: Value) => {
				if (String(input).includes("/gateway/bot"))
					return Response.json({ url: "wss://fake.discord.test" });
				const pair = new WebSocketPair();
				server = pair[1];
				server.accept();
				return new Response(null, { status: 101, webSocket: pair[0] });
			}),
		);
		await inspect(stub, async (instance, state) => {
			await state.storage.put("enabled", true);
			await instance.connect();
			await instance.frame({
				op: 0,
				s: 7,
				t: "READY",
				d: {
					session_id: "fatal-session",
					resume_gateway_url: "wss://fake.discord.test",
				},
			});
			const closed = new Promise<void>((resolve) =>
				instance.socket.addEventListener("close", () => resolve(), {
					once: true,
				}),
			);
			server.close(code, "fatal");
			await closed;
			await instance.capture(async () => {});
			expect(await state.storage.get("enabled")).toBe(false);
			expect((await state.storage.get<Value>("lastFailure")).reason).toContain(
				String(code),
			);
			const calls = vi.mocked(fetch).mock.calls.length;
			await instance.alarm();
			await instance.alarm();
			expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
		});
	},
);
it.each([4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009])(
	"recovers from Discord close %i with appropriate session state",
	async (code) => {
		const stub = gateway();
		let server!: WebSocket;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: Value) => {
				if (String(input).includes("/gateway/bot"))
					return Response.json({ url: "wss://fake.discord.test" });
				const pair = new WebSocketPair();
				server = pair[1];
				server.accept();
				return new Response(null, { status: 101, webSocket: pair[0] });
			}),
		);
		await inspect(stub, async (instance, state) => {
			await state.storage.put("enabled", true);
			await instance.connect();
			await instance.frame({
				op: 0,
				s: 7,
				t: "READY",
				d: {
					session_id: "recover-session",
					resume_gateway_url: "wss://fake.discord.test",
				},
			});
			const closed = new Promise<void>((resolve) =>
				instance.socket.addEventListener("close", () => resolve(), {
					once: true,
				}),
			);
			server.close(code, "recover");
			await closed;
			await instance.capture(async () => {});
			expect(await state.storage.get("enabled")).toBe(true);
			expect(await state.storage.get("session")).toEqual(
				code === 4007 || code === 4009
					? { seq: null }
					: { id: "recover-session", url: "wss://fake.discord.test", seq: 7 },
			);
			await instance.alarm();
			const response = new Promise<Value>((resolve) =>
				server.addEventListener(
					"message",
					(event) => resolve(JSON.parse(String(event.data))),
					{ once: true },
				),
			);
			server.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
			expect((await response).op).toBe(code === 4007 || code === 4009 ? 2 : 6);
			instance.disconnect(false);
		});
	},
);

it("persists a captured 100-user page across budget yields, committed-response loss and eviction", async () => {
	const stub = gateway();
	const users = Array.from({ length: 100 }, (_, index) => ({
		id: `budget-user-${index}`,
		bot: false,
	}));
	let enumerations = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Value) => {
			const url = new URL(String(input));
			if (url.pathname.includes("/reactions/")) {
				enumerations++;
				return Response.json(url.searchParams.has("after") ? [] : users);
			}
			throw new Error(url.href);
		}),
	);
	const budgets: D1QueryBudget[] = [];
	const wrap = D1QueryBudget.prototype.wrap;
	vi.spyOn(D1QueryBudget.prototype, "wrap").mockImplementation(function (
		this: D1QueryBudget,
		database: D1Database,
	) {
		budgets.push(this);
		return wrap.call(this, database);
	});
	await inspect(stub, async (instance, state) => {
		const job = {
			kind: "backfill",
			id: "backfill:budget-guild",
			attempts: 0,
			due: 0,
			data: {
				guildId: "budget-guild",
				scanId: "captured-budget-scan",
				channelIds: ["budget-channel"],
				channelIndex: 0,
				limit: 1,
				scanned: 0,
				message: {
					id: "budget-message",
					author: { id: "budget-author", bot: false },
					reactions: [{ emoji: { name: "👍" } }],
				},
				reactionIndex: 0,
			},
		};
		await state.storage.put(`job:${job.id}`, job);
		const original = instance.env.DB as D1Database;
		let committed = 0;
		instance.env = {
			...instance.env,
			DB: new Proxy(original, {
				get(target, key) {
					if (key === "batch")
						return async (statements: D1PreparedStatement[]) => {
							const result = await target.batch(statements);
							if (++committed === 5) {
								throw new Error("Committed D1 batch response lost");
							}
							return result;
						};
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
		};
		await instance.alarm();
		const pending = await state.storage.get<Value>(`job:${job.id}`);
		expect(pending.attempts).toBe(0);
		expect(pending.data.usersPage).toHaveLength(100);
		expect(pending.data.userIndex).toBe(4);
		expect(pending.data.userAfter).toBe("budget-user-3");
	});
	const db = new Database(env.DB);
	expect((await db.getBalance("budget-author")).balanceUnits).toBe(50000);
	await evictDurableObject(stub);
	let complete = false;
	for (let round = 0; round < 40; round++) {
		await drain(stub);
		await inspect(stub, async (_, state) => {
			const pending = await state.storage.get<Value>(
				"job:backfill:budget-guild",
			);
			if (!pending) {
				complete = true;
				return;
			}
			expect(pending.attempts).toBe(0);
			if (pending.data.usersPage) {
				expect(pending.data.userIndex).toBeGreaterThan(0);
				expect(pending.data.usersPage).toHaveLength(100);
			}
		});
		if (complete) break;
		if (round === 3) await evictDurableObject(stub);
	}
	expect(complete).toBe(true);
	expect((await db.getBalance("budget-author")).balanceUnits).toBe(1000000);
	expect(enumerations).toBe(2);
	expect(budgets.length).toBeGreaterThan(2);
	expect(budgets.every((budget) => budget.used <= 50)).toBe(true);
	const receipts = await env.DB.prepare(
		"SELECT count(*) AS count FROM operation_receipts WHERE id LIKE ?",
	)
		.bind("backfill:captured-budget-scan:%")
		.first<{ count: number }>();
	expect(receipts?.count).toBe(100);
});

it.each([0, 1])(
	"gives every expensive backfill and event a fresh-budget turn under sustained order load (initial lane %i)",
	async (initialLane) => {
		const stub = gateway();
		const db = new Database(env.DB);
		const base = BigInt(Date.now() - 1420070400000) << 22n;
		const commands: Value[] = [];
		for (let index = 0; index < 40; index++) {
			const maker = `8${initialLane}${String(index).padStart(3, "0")}0`;
			const buyer = `7${initialLane}${String(index).padStart(3, "0")}0`;
			const market = await db.createMarket({
				guildId: "223000",
				creatorId: "223001",
				oracleUserId: "223001",
				description: "Fair budget matching",
				outcomeDescriptions: ["Yes", "No"],
			});
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO users(discord_id,balance_units,locked_units) VALUES(?,100000,6000),(?,100000,0)",
				).bind(maker, buyer),
				env.DB.prepare(
					"INSERT INTO orders(id,user_id,market_id,outcome_id,direction,quantity_units,price_units,escrow_units,created_at) VALUES(?,?,?,?,'buy',10000,6000,6000,0)",
				).bind(
					`expense-maker:${initialLane}:${index}`,
					maker,
					market.id,
					market.outcomes[0].id,
				),
			]);
			const id = (base + BigInt(index)).toString();
			commands.push({
				kind: "command",
				id: `command:${id}`,
				attempts: 0,
				due: 0,
				data: {
					id,
					application_id: "123",
					token: "fake",
					type: 2,
					guild_id: "223000",
					member: { user: { id: buyer } },
					data: {
						name: "market",
						options: [
							{
								name: "order",
								type: 1,
								options: [
									{ name: "market", type: 3, value: market.id },
									{ name: "outcome", type: 3, value: market.outcomes[1].id },
									{ name: "direction", type: 3, value: "buy" },
									{ name: "quantity", type: 4, value: 1 },
									{ name: "price", type: 10, value: 0.6 },
								],
							},
						],
					},
				},
			});
		}
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: Value) => {
				const url = new URL(String(input));
				if (url.pathname.includes("/webhooks/"))
					return new Response(null, { status: 204 });
				if (url.pathname.includes("/reactions/"))
					return Response.json(
						Array.from({ length: 100 }, (_, index) => ({
							id: `expense-reactor-${index}`,
							bot: false,
						})),
					);
				if (url.pathname.includes("/expense-live/"))
					return Response.json({
						author: { id: `expense-event-author-${initialLane}`, bot: false },
					});
				throw new Error(url.href);
			}),
		);
		await inspect(stub, async (_, state) => {
			await state.storage.put("scheduler-lane", initialLane);
			for (const job of commands) await state.storage.put(`job:${job.id}`, job);
			for (let index = 0; index < 64; index++) {
				const id = `event:${String(index).padStart(16, "0")}:expense:${initialLane}`;
				await state.storage.put(`job:${id}`, {
					kind: "event",
					id,
					attempts: 0,
					due: 0,
					data: {
						op: 0,
						t: "MESSAGE_REACTION_ADD",
						d: {
							guild_id: "223000",
							channel_id: "expense-live",
							message_id: `expense-live:${initialLane}:${index}`,
							user_id: "expense-live-reactor",
							member: { user: { id: "expense-live-reactor", bot: false } },
							emoji: { name: "👍" },
						},
					},
				});
			}
			for (let index = 0; index < 16; index++) {
				const id = `backfill:expense-${String(index).padStart(2, "0")}`;
				await state.storage.put(`job:${id}`, {
					kind: "backfill",
					id,
					attempts: 0,
					due: 0,
					data: {
						guildId: `expense-${index}`,
						scanId: `expense:${initialLane}:${index}`,
						channelIds: ["expense-backfill"],
						channelIndex: 0,
						limit: 1000,
						scanned: 0,
						message: {
							id: `expense-message:${initialLane}:${index}`,
							author: {
								id: `expense-backfill-author:${initialLane}:${index}`,
								bot: false,
							},
							reactions: [{ emoji: { name: "👍" } }],
						},
					},
				});
			}
		});
		for (let round = 0; round < 36; round++) await drain(stub);
		expect(
			(await db.getBalance(`expense-event-author-${initialLane}`)).balanceUnits,
		).toBeGreaterThan(0);
		for (let index = 0; index < 16; index++)
			expect(
				(await db.getBalance(`expense-backfill-author:${initialLane}:${index}`))
					.balanceUnits,
			).toBeGreaterThan(0);
	},
);
