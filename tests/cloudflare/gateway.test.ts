import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayUpgradeUrl } from "../../src/cloudflare/gateway";
import { Database } from "../../src/database";

// biome-ignore lint/suspicious/noExplicitAny: White-box failure injection intentionally inspects private runtime fields and persisted JSON.
type TestValue = any;

const runtimeFetch = globalThis.fetch.bind(globalThis);

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
	it("preserves the earliest drain deadline during sustained irrelevant dispatches", async () => {
		const stub = gateway();
		const db = new Database(env.DB);
		await db.addReaction(
			"schedule-message",
			"schedule-reactor",
			"schedule-author",
			"x",
			"schedule-add",
		);
		const origin = Date.now();
		let offset = 0;
		const clock = vi
			.spyOn(Date, "now")
			.mockImplementation(() => origin + offset);
		try {
			await inside(stub, async (instance, state) => {
				await instance.frame({
					op: 0,
					s: 1,
					t: "READY",
					d: {
						session_id: "alarm-session",
						resume_gateway_url: "wss://gateway.discord.gg",
					},
				});
				const id = ((BigInt(origin - 1420070400000) << 22n) + 25n).toString();
				const response = await instance.fetch(
					new Request("https://gateway/commands", {
						method: "POST",
						body: JSON.stringify({
							id,
							application_id: env.CLIENT_ID,
							token: "fake-alarm",
							type: 2,
							guild_id: "91",
							member: { user: { id: "92" } },
							data: { name: "balance" },
						}),
					}),
				);
				expect(response.ok).toBe(true);
				await response.text();
				await instance.frame({
					op: 0,
					s: 2,
					t: "MESSAGE_REACTION_REMOVE",
					d: {
						guild_id: "91",
						message_id: "schedule-message",
						user_id: "schedule-reactor",
						emoji: { name: "x" },
					},
				});
				const due = await state.storage.getAlarm();
				for (let sequence = 3; sequence < 23; sequence++) {
					offset += 100;
					await instance.frame({
						op: 0,
						s: sequence,
						t: "MESSAGE_CREATE",
						d: {},
					});
					expect(await state.storage.getAlarm()).toBe(due);
				}
			});
			expect(await runDurableObjectAlarm(stub)).toBe(true);
			expect((await db.getBalance("schedule-author")).balanceUnits).toBe(0);
			let edits = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					edits++;
					return new Response(null, { status: 204 });
				}),
			);
			await inside(stub, async (instance, state) => {
				const due = await state.storage.getAlarm();
				for (let sequence = 23; sequence < 43; sequence++) {
					offset += 100;
					await instance.frame({
						op: 0,
						s: sequence,
						t: "MESSAGE_CREATE",
						d: {},
					});
					expect(await state.storage.getAlarm()).toBe(due);
				}
			});
			expect(await runDurableObjectAlarm(stub)).toBe(true);
			expect(edits).toBe(1);
			await inside(stub, async (_, state) => {
				expect((await state.storage.list({ prefix: "job:" })).size).toBe(0);
			});
		} finally {
			clock.mockRestore();
		}
	});

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
	it("converts Gateway WSS URLs to HTTPS and rejects insecure production endpoints", async () => {
		expect(gatewayUpgradeUrl("wss://gateway.discord.gg/?v=10").href).toBe(
			"https://gateway.discord.gg/?v=10",
		);
		expect(() => gatewayUpgradeUrl("ws://gateway.discord.gg")).toThrow();
		expect(() => gatewayUpgradeUrl("http://gateway.discord.gg")).toThrow();
		expect(gatewayUpgradeUrl("ws://127.0.0.1:1234", true).protocol).toBe(
			"http:",
		);
		await expect(
			runtimeFetch("wss://unsupported.invalid", {
				headers: { Upgrade: "websocket" },
			}),
		).rejects.toThrow();
	});
	it("replays an uncaptured reaction after capacity recovery without invalidating the Discord session", async () => {
		const stub = gateway();
		let server!: WebSocket;
		let resumable = true;
		const frame = {
			op: 0,
			s: 2,
			t: "MESSAGE_REACTION_ADD",
			d: {
				guild_id: "777001",
				channel_id: "777002",
				message_id: "777003",
				user_id: "777004",
				member: { user: { id: "777004", bot: false } },
				emoji: { name: "👍" },
			},
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (String(url).includes("/gateway/bot"))
					return Response.json({ url: "wss://fake.discord.test" });
				if (String(url).includes("/channels/777002/messages/777003"))
					return Response.json({ author: { id: "777005", bot: false } });
				expect(new URL(String(url)).protocol).toBe("https:");
				const pair = new WebSocketPair();
				server = pair[1];
				server.accept();
				server.addEventListener("close", (event) => {
					if (event.code === 1000 || event.code === 1001) resumable = false;
				});
				return new Response(null, { status: 101, webSocket: pair[0] });
			}),
		);
		await inside(stub, async (instance, state) => {
			const receive = () =>
				new Promise<TestValue>((resolve) =>
					server.addEventListener(
						"message",
						(event) => resolve(JSON.parse(String(event.data))),
						{ once: true },
					),
				);
			const dispatch = async (payload: TestValue) => {
				const received = new Promise<void>((resolve) =>
					instance.socket.addEventListener("message", () => resolve(), {
						once: true,
					}),
				);
				server.send(JSON.stringify(payload));
				await received;
				await instance.capture(async () => {});
			};
			await instance.connect();
			let response = receive();
			server.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
			expect((await response).op).toBe(2);
			await dispatch({
				op: 0,
				s: 1,
				t: "READY",
				d: {
					session_id: "held-session",
					resume_gateway_url: "wss://fake.discord.test",
				},
			});
			const filler: Record<string, TestValue> = {};
			for (let i = 0; i < 512; i++)
				filler[`job:filler:${i}`] = { kind: "event" };
			const entries = Object.entries(filler);
			for (let i = 0; i < entries.length; i += 128)
				await state.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
			const closed = new Promise<number>((resolve) =>
				server.addEventListener("close", (event) => resolve(event.code), {
					once: true,
				}),
			);
			await dispatch(frame);
			expect(await closed).toBe(4000);
			expect(resumable).toBe(true);
			expect((await state.storage.get<TestValue>("session")).seq).toBe(1);
			const keys = Object.keys(filler);
			for (let i = 0; i < keys.length; i += 128)
				await state.storage.delete(keys.slice(i, i + 128));
			await instance.connect();
			response = receive();
			server.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45000 } }));
			expect(await response).toMatchObject({
				op: 6,
				d: { session_id: "held-session", seq: 1 },
			});
			if (resumable) {
				await dispatch(frame);
				await dispatch(frame);
			} else await dispatch({ op: 9, d: false });
			await instance.alarm();
			expect(
				(await new Database(env.DB).getBalance("777005")).balanceUnits,
			).toBe(10000);
			expect((await state.storage.list({ prefix: "job:" })).size).toBe(0);
			instance.disconnect(false);
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
				expect(new URL(String(url)).protocol).toBe("https:");
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
