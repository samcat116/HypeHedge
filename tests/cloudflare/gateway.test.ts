import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayDO } from "../../src/cloudflare/gateway";
import { Database } from "../../src/database";

// biome-ignore lint/suspicious/noExplicitAny: White-box failure injection intentionally inspects private runtime fields and persisted JSON.
type TestValue = any;

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("Unexpected network"))),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
});
function gateway() {
	return env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
}
async function inside(
	stub: TestValue,
	fn: (instance: TestValue, state: DurableObjectState) => Promise<void>,
) {
	await (
		runInDurableObject as unknown as (
			stub: DurableObjectStub,
			fn: (instance: TestValue, state: DurableObjectState) => Promise<void>,
		) => Promise<void>
	)(stub, fn);
}

describe("durable Gateway capture", () => {
	it("captures before checkpoint and deduplicates replayed sequence", async () => {
		const stub = gateway();
		await inside(stub, async (instance, state) => {
			await instance.frame({
				op: 0,
				s: 1,
				t: "READY",
				d: {
					session_id: "test-session",
					resume_gateway_url: "wss://gateway.discord.gg",
				},
			});
			await instance.frame({
				op: 0,
				s: 2,
				t: "MESSAGE_REACTION_REMOVE",
				d: {
					guild_id: "1",
					message_id: "2",
					user_id: "3",
					emoji: { name: "👍" },
				},
			});
			await instance.frame({
				op: 0,
				s: 2,
				t: "MESSAGE_REACTION_REMOVE",
				d: {
					guild_id: "1",
					message_id: "2",
					user_id: "3",
					emoji: { name: "👍" },
				},
			});
			expect((await state.storage.list({ prefix: "job:" })).size).toBe(1);
			expect((await state.storage.get<TestValue>("session")).seq).toBe(2);
		});
	});
	it("does not advance checkpoint when capture capacity is exhausted", async () => {
		const stub = gateway();
		await inside(stub, async (instance, state) => {
			await instance.frame({
				op: 0,
				s: 1,
				t: "READY",
				d: {
					session_id: "test-session",
					resume_gateway_url: "wss://gateway.discord.gg",
				},
			});
			const items: Record<string, TestValue> = {};
			for (let i = 0; i < 512; i++) items[`job:full:${i}`] = { kind: "event" };
			for (let i = 0; i < 512; i += 128)
				await state.storage.put(
					Object.fromEntries(Object.entries(items).slice(i, i + 128)),
				);
			await instance.frame({
				op: 0,
				s: 2,
				t: "MESSAGE_REACTION_REMOVE",
				d: {},
			});
			expect((await state.storage.get<TestValue>("session")).seq).toBe(1);
		});
	});
	it("persists interaction before acknowledging and replays do not duplicate work", async () => {
		const stub = gateway();
		const body = JSON.stringify({
			id: "123456789",
			token: "fake",
			application_id: "123",
		});
		expect(
			(await stub.fetch("https://gateway/commands", { method: "POST", body }))
				.status,
		).toBe(200);
		expect(
			(await stub.fetch("https://gateway/commands", { method: "POST", body }))
				.status,
		).toBe(200);
		await inside(stub, async (_, state) =>
			expect((await state.storage.list({ prefix: "job:" })).size).toBe(1),
		);
	});
	it("admits commands while the effect lane is stalled", async () => {
		const stub = gateway();
		await inside(stub, async (instance) => {
			instance.serial = new Promise(() => {});
		});
		const response = await stub.fetch("https://gateway/commands", {
			method: "POST",
			body: JSON.stringify({
				id: "123456789",
				token: "fake",
				application_id: "123",
			}),
		});
		expect(response.status).toBe(200);
		await inside(stub, async (instance) => {
			instance.serial = Promise.resolve();
		});
	});
	it("rejects a changed interaction payload on replay", async () => {
		const stub = gateway();
		await stub.fetch("https://gateway/commands", {
			method: "POST",
			body: JSON.stringify({ id: "123456789", token: "fake" }),
		});
		expect(
			(
				await stub.fetch("https://gateway/commands", {
					method: "POST",
					body: JSON.stringify({ id: "123456789", token: "changed" }),
				})
			).status,
		).toBe(503);
	});
	it("retains failed REST work and blocks later event effects", async () => {
		const stub = gateway();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ retry_after: 5 }, { status: 429 })),
		);
		await inside(stub, async (instance, state) => {
			await instance.frame({
				op: 0,
				s: 1,
				t: "READY",
				d: {
					session_id: "test-session",
					resume_gateway_url: "wss://gateway.discord.gg",
				},
			});
			await instance.frame({
				op: 0,
				s: 2,
				t: "MESSAGE_REACTION_ADD",
				d: {
					guild_id: "1",
					channel_id: "4",
					message_id: "2",
					user_id: "3",
					emoji: { name: "👍" },
				},
			});
			await instance.frame({
				op: 0,
				s: 3,
				t: "MESSAGE_REACTION_REMOVE",
				d: {
					guild_id: "1",
					channel_id: "4",
					message_id: "2",
					user_id: "3",
					emoji: { name: "👍" },
				},
			});
			await instance.alarm();
			const jobs = [
				...(await state.storage.list<TestValue>({ prefix: "job:" })).values(),
			];
			expect(jobs).toHaveLength(2);
			expect(jobs[0].attempts).toBe(1);
			expect(jobs[0].due).toBeGreaterThan(Date.now() + 3000);
			expect(jobs[1].attempts).toBe(0);
		});
	});
	it("opens actual outbound sockets and resumes after reconnect", async () => {
		const stub = gateway();
		let server!: WebSocket;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (String(url).includes("/gateway/bot"))
					return Response.json({ url: "wss://fake.discord.test" });
				const pair = new WebSocketPair();
				server = pair[1];
				server.accept();
				return new Response(null, { status: 101, webSocket: pair[0] });
			}),
		);
		await inside(stub, async (instance) => {
			await instance.connect();
			function receive() {
				return new Promise<TestValue>((resolve) =>
					server.addEventListener(
						"message",
						(event) => resolve(JSON.parse(String(event.data))),
						{ once: true },
					),
				);
			}
			let response = receive();
			server.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
			expect((await response).op).toBe(2);
			const captured = new Promise<void>((resolve) =>
				instance.socket.addEventListener("message", () => resolve(), {
					once: true,
				}),
			);
			server.send(
				JSON.stringify({
					op: 0,
					s: 1,
					t: "READY",
					d: {
						session_id: "real-socket",
						resume_gateway_url: "wss://fake.discord.test",
					},
				}),
			);
			await captured;
			// A status call is serialized behind the captured READY event.
			await instance.capture(async () => {});
			instance.disconnect();
			await instance.connect();
			response = receive();
			server.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
			expect(await response).toMatchObject({
				op: 6,
				d: { session_id: "real-socket", seq: 1 },
			});
			response = receive();
			instance.beat();
			expect((await response).op).toBe(1);
			const acknowledged = new Promise<void>((resolve) =>
				instance.socket.addEventListener("message", () => resolve(), {
					once: true,
				}),
			);
			server.send(JSON.stringify({ op: 11 }));
			await acknowledged;
			await instance.capture(async () => {});
			expect(instance.acknowledged).toBe(true);
			instance.disconnect();
		});
	});
	it("executes a durable backfill command without a self fetch", async () => {
		const stub = gateway();
		const id = ((BigInt(Date.now() - 1420070400000) << 22n) + 1n).toString();
		await stub.fetch("https://gateway/commands", {
			method: "POST",
			body: JSON.stringify({
				id,
				application_id: "123",
				token: "fake",
				type: 2,
				guild_id: "1234",
				member: { user: { id: "1235" }, permissions: "8" },
				data: { name: "backfill" },
			}),
		});
		await inside(stub, async (instance, state) => {
			await instance.alarm();
			const jobs = [
				...(await state.storage.list<TestValue>({ prefix: "job:" })).values(),
			];
			expect(jobs.find((j) => j.kind === "backfill").data.scanId).toBe(id);
			expect(jobs.find((j) => j.id === `command:${id}`).kind).toBe("reply");
		});
	});
	it("stops an oversized reaction scan observably before another fetch", async () => {
		const stub = gateway();
		await inside(stub, async (instance, state) => {
			await state.storage.put("job:backfill:1234", {
				kind: "backfill",
				id: "backfill:1234",
				attempts: 0,
				due: 0,
				data: {
					scanId: "scan",
					guildId: "1234",
					channelIds: ["1235"],
					channelIndex: 0,
					limit: 100,
					scanned: 0,
					userPages: 100,
					message: {
						id: "1236",
						author: { id: "1237", bot: false },
						reactions: [{ emoji: { name: "👍" } }],
					},
				},
			});
			await instance.alarm();
			expect((await state.storage.list({ prefix: "job:" })).size).toBe(0);
			expect(await state.storage.get("failures")).toBe(1);
			expect(vi.mocked(fetch)).not.toHaveBeenCalled();
		});
	});
	it("uses fresh scan receipts to repair a removed award without double credit on retries", async () => {
		const stub = gateway();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json([{ id: "987652", bot: false }])),
		);
		await inside(stub, async (instance) => {
			const db = new Database(env.DB);
			const data = {
				scanId: "first",
				guildId: "987650",
				channelIds: ["987651"],
				channelIndex: 0,
				limit: 100,
				scanned: 0,
				message: {
					id: "987653",
					author: { id: "987654", bot: false },
					reactions: [{ emoji: { name: "👍" } }],
				},
				reactionIndex: 0,
			};
			const job = {
				kind: "backfill",
				id: "backfill:test",
				data,
				attempts: 0,
				due: 0,
			};
			await instance.backfill(job, db);
			expect((await db.getBalance("987654")).balanceUnits).toBe(10000);
			data.reactionIndex = 0;
			await instance.backfill(job, db);
			expect((await db.getBalance("987654")).balanceUnits).toBe(10000);
			await db.removeReaction("987653", "987652", "👍", "live-remove");
			data.scanId = "second";
			data.reactionIndex = 0;
			await instance.backfill(job, db);
			expect((await db.getBalance("987654")).balanceUnits).toBe(10000);
		});
	});

	it("identifies, resumes and invalidates nonresumable sessions", async () => {
		const stub = gateway();
		await inside(stub, async (instance, state) => {
			const sent: TestValue[] = [];
			instance.socket = {
				send: (x: string) => sent.push(JSON.parse(x)),
				close: () => {},
				readyState: 1,
			};
			await instance.frame({ op: 10, d: { heartbeat_interval: 45000 } });
			expect(sent[0].op).toBe(2);
			expect(sent[0].d.intents).toBe(1537);
			await instance.frame({
				op: 0,
				s: 1,
				t: "READY",
				d: {
					session_id: "abc",
					resume_gateway_url: "wss://gateway.discord.gg",
				},
			});
			await instance.frame({ op: 10, d: { heartbeat_interval: 45000 } });
			expect(sent[1]).toMatchObject({
				op: 6,
				d: { session_id: "abc", seq: 1 },
			});
			await instance.frame({ op: 9, d: false });
			expect(await state.storage.get("session")).toEqual({ seq: null });
		});
	});
	it("reconnects after a missed heartbeat acknowledgment", async () => {
		const stub = gateway();
		await inside(stub, async (instance, state) => {
			let closed = false;
			instance.socket = {
				send: () => {},
				close: () => {
					closed = true;
				},
				readyState: 1,
			};
			instance.beat();
			expect(closed).toBe(false);
			instance.beat();
			expect(closed).toBe(true);
		});
	});
});
