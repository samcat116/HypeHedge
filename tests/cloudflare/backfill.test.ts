import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "../../src/database";
// biome-ignore lint/suspicious/noExplicitAny: Failure injection inspects private durable JSON and effect-lane state.
type TestValue = any;
function gateway() {
	return env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
}
async function inside(
	stub: DurableObjectStub,
	fn: (instance: TestValue, state: DurableObjectState) => Promise<void>,
) {
	await (
		runInDurableObject as unknown as (
			stub: DurableObjectStub,
			fn: (instance: TestValue, state: DurableObjectState) => Promise<void>,
		) => Promise<void>
	)(stub, fn);
}
async function admit(stub: DurableObjectStub, data: TestValue) {
	const response = await stub.fetch("https://gateway/backfill", {
		method: "POST",
		body: JSON.stringify(data),
	});
	await response.text();
	return response;
}
async function tick(stub: DurableObjectStub) {
	await inside(stub, async (instance, state) => {
		for (const [key, job] of await state.storage.list<TestValue>({
			prefix: "job:",
		})) {
			job.due = 0;
			await state.storage.put(key, job);
		}
		await state.storage.delete("restPause");
		await instance.alarm();
	});
}
async function current(stub: DurableObjectStub, guild = "991001") {
	let value: TestValue;
	await inside(stub, async (_, state) => {
		value = await state.storage.get(`job:backfill:${guild}`);
	});
	return value;
}
beforeEach(() =>
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("Unexpected network"))),
	),
);
afterEach(() => vi.unstubAllGlobals());
const channels = [
	{ id: "991002", type: 0 },
	{ id: "991003", type: 0 },
];
const message = {
	id: "991004",
	author: { id: "991005", bot: false },
	reactions: [{ emoji: { name: "👍" } }],
};

describe("backfill permanent-resource recovery", () => {
	it.each([403, 404])(
		"skips inaccessible channel %i and awards in the next readable channel",
		async (status) => {
			const stub = gateway();
			const author = `${status}991005`;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: TestValue) => {
					const path = new URL(String(input)).pathname.replace("/api/v10", "");
					if (path.includes("/guilds/")) return Response.json(channels);
					if (path === "/channels/991002/messages")
						return new Response(null, { status });
					if (path === "/channels/991003/messages")
						return Response.json([
							{
								...message,
								id: `${status}991004`,
								author: { id: author, bot: false },
							},
						]);
					if (path.includes("/reactions/"))
						return Response.json([{ id: "991006", bot: false }]);
					throw new Error(path);
				}),
			);
			await admit(stub, { guildId: "991001", limit: 1 });
			await tick(stub);
			await tick(stub);
			await tick(stub);
			expect((await new Database(env.DB).getBalance(author)).balanceUnits).toBe(
				10000,
			);
			expect(await current(stub)).toBeUndefined();
			await inside(stub, async (_, state) => {
				expect(await state.storage.get("failures")).toBe(1);
				expect(
					(await state.storage.get<TestValue>("lastFailure")).reason,
				).toContain("channel");
			});
		},
	);
	it("skips a channel denied during reaction enumeration and reaches a readable channel", async () => {
		const stub = gateway();
		const author = "reaction-denied-author";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: TestValue) => {
				const path = new URL(String(input)).pathname.replace("/api/v10", "");
				if (path.includes("/guilds/")) return Response.json(channels);
				if (path.endsWith("/messages"))
					return Response.json([
						{
							...message,
							id: "reaction-denied-message",
							author: { id: author, bot: false },
						},
					]);
				if (
					path.startsWith("/channels/991002/") &&
					path.includes("/reactions/")
				)
					return new Response(null, { status: 403 });
				if (path.includes("/reactions/"))
					return Response.json([{ id: "991006", bot: false }]);
				throw new Error(path);
			}),
		);
		await admit(stub, { guildId: "991001", limit: 1 });
		await tick(stub);
		expect((await current(stub)).data.channelIndex).toBe(1);
		await tick(stub);
		await tick(stub);
		expect((await new Database(env.DB).getBalance(author)).balanceUnits).toBe(
			10000,
		);
		expect(await current(stub)).toBeUndefined();
	});

	it("skips a deleted message during reaction enumeration and continues its channel", async () => {
		const stub = gateway();
		const author = "992005";
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: TestValue) => {
				const url = new URL(String(input));
				if (url.pathname.includes("/guilds/"))
					return Response.json([channels[0]]);
				if (url.pathname.endsWith("/messages"))
					return Response.json([
						{
							...message,
							id: url.searchParams.has("before") ? "992004" : "deleted",
							author: { id: author, bot: false },
						},
					]);
				if (url.pathname.includes("/deleted/reactions/"))
					return new Response(null, { status: 404 });
				if (url.pathname.includes("/reactions/"))
					return Response.json([{ id: "992006", bot: false }]);
				throw new Error(url.href);
			}),
		);
		await admit(stub, { guildId: "991001", limit: 2 });
		await tick(stub);
		expect((await current(stub)).data.before).toBe("deleted");
		await tick(stub);
		await tick(stub);
		expect((await new Database(env.DB).getBalance(author)).balanceUnits).toBe(
			10000,
		);
		expect(await current(stub)).toBeUndefined();
	});
	it.each([403, 404])(
		"terminal guild enumeration %i releases the slot for a new scan",
		async (status) => {
			const stub = gateway();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(null, { status })),
			);
			await admit(stub, { guildId: "991001" });
			await tick(stub);
			expect(await current(stub)).toBeUndefined();
			expect((await admit(stub, { guildId: "991001" })).ok).toBe(true);
			expect(await current(stub)).toBeDefined();
		},
	);
	it.each([429, 503, "network"])(
		"retains transient %s failures for retry",
		async (status) => {
			const stub = gateway();
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					if (status === "network") throw new Error("offline");
					return Response.json(
						{ retry_after: 5 },
						{ status: status as number },
					);
				}),
			);
			await admit(stub, { guildId: "991001" });
			const before = await current(stub);
			await tick(stub);
			const after = await current(stub);
			expect(after.data.scanId).toBe(before.data.scanId);
			expect(after.attempts).toBe(1);
			expect(after.data.channelIndex).toBe(0);
			expect(after.due).toBeGreaterThan(Date.now());
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => Response.json([])),
			);
			await tick(stub);
			expect(await current(stub)).toBeUndefined();
		},
	);
});

describe("durable backfill reset admission", () => {
	it("keeps active progress for reset false and replaces all progress for reset true", async () => {
		const stub = gateway();
		const db = new Database(env.DB);
		await db.addReaction(
			"reset-award-message",
			"reset-reactor",
			"reset-author",
			"👍",
			"reset-award",
		);
		await admit(stub, { guildId: "991001", limit: 100, interactionId: "100" });
		await inside(stub, async (_, state) => {
			const old = await state.storage.get<TestValue>("job:backfill:991001");
			old.data.before = "cursor";
			old.data.channelIds = ["991002"];
			old.data.userAfter = "reactor";
			old.attempts = 4;
			old.due = Date.now() + 60000;
			await state.storage.put("job:backfill:991001", old);
		});
		await admit(stub, {
			guildId: "991001",
			limit: 200,
			reset: false,
			interactionId: "101",
		});
		expect((await current(stub)).data.before).toBe("cursor");
		await admit(stub, {
			guildId: "991001",
			limit: 300,
			reset: true,
			interactionId: "102",
		});
		expect(await current(stub)).toMatchObject({
			attempts: 0,
			data: { scanId: "102", limit: 300, scanned: 0, channelIndex: 0 },
		});
		expect((await current(stub)).data.before).toBeUndefined();
		expect((await current(stub)).data.channelIds).toBeUndefined();
		expect((await current(stub)).data.userAfter).toBeUndefined();
		expect((await db.getBalance("reset-author")).balanceUnits).toBe(10000);
	});
	it("allows resetting an existing scan when the queue is full", async () => {
		const stub = gateway();
		await admit(stub, { guildId: "991001", interactionId: "120" });
		await inside(stub, async (_, state) => {
			const entries = Array.from({ length: 511 }, (_, i) => [
				`job:held:${i}`,
				{
					kind: "event",
					id: `held:${i}`,
					attempts: 0,
					due: Date.now() + 60000,
					data: {},
				},
			]);
			for (let i = 0; i < entries.length; i += 128)
				await state.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
		});
		expect(
			(
				await admit(stub, {
					guildId: "991001",
					limit: 250,
					reset: true,
					interactionId: "121",
				})
			).status,
		).toBe(200);
		expect((await current(stub)).data.scanId).toBe("121");
		await inside(stub, async (_, state) =>
			expect((await state.storage.list({ prefix: "job:" })).size).toBe(512),
		);
	});
	it("returns durable queue-full replies so a saturated command queue can drain", async () => {
		const stub = gateway();
		const base = BigInt(Date.now() - 1420070400000) << 22n;
		await inside(stub, async (instance, state) => {
			const entries = Array.from({ length: 512 }, (_, index) => {
				const id = (base + BigInt(index)).toString();
				return [
					`job:command:${id}`,
					{
						kind: "command",
						id: `command:${id}`,
						attempts: 0,
						due: 0,
						data: {
							id,
							application_id: "123",
							token: "fake",
							type: 2,
							guild_id: "991001",
							member: { user: { id: "991006" }, permissions: "8" },
							data: { name: "backfill" },
						},
					},
				];
			});
			for (let i = 0; i < entries.length; i += 128)
				await state.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
			await instance.alarm();
			const jobs = [
				...(await state.storage.list<TestValue>({ prefix: "job:" })).values(),
			];
			expect(jobs.filter((job) => job.kind === "reply")).toHaveLength(16);
			expect(jobs[0].data.payload.content).toContain("queue is full");
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(null, { status: 204 })),
			);
			await instance.alarm();
			expect((await state.storage.list({ prefix: "job:" })).size).toBeLessThan(
				512,
			);
		});
	});

	it("deduplicates reset across eviction and prevents older replay replacing newer scan", async () => {
		const stub = gateway();
		const old = {
			guildId: "991001",
			limit: 100,
			reset: true,
			interactionId: "200",
		};
		await admit(stub, old);
		await admit(stub, { ...old, limit: 200, interactionId: "201" });
		await evictDurableObject(stub);
		await admit(stub, old);
		expect((await current(stub)).data.scanId).toBe("201");
		expect((await admit(stub, { ...old, limit: 300 })).status).toBe(409);
		await inside(stub, async (_, state) => {
			await state.storage.delete("job:backfill:991001");
		});
		await evictDurableObject(stub);
		await admit(stub, old);
		expect(await current(stub)).toBeUndefined();
	});
	it.each([200, 403, 503, 429])(
		"fences stale in-flight completion/error %i from replacement progress",
		async (status) => {
			const stub = gateway();
			await admit(stub, { guildId: "991001", interactionId: "300" });
			let release!: () => void;
			let requested!: () => void;
			const waiting = new Promise<void>((resolve) => {
				requested = resolve;
			});
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					requested();
					await held;
					return Response.json(status === 200 ? [] : { retry_after: 5 }, {
						status,
					});
				}),
			);
			await inside(stub, async (instance, state) => {
				const running = instance.alarm();
				await waiting;
				expect(
					(
						await instance.fetch(
							new Request("https://gateway/backfill", {
								method: "POST",
								body: JSON.stringify({
									guildId: "991001",
									limit: 250,
									reset: true,
									interactionId: "301",
								}),
							}),
						)
					).ok,
				).toBe(true);
				release();
				await running;
				expect(
					(await state.storage.get<TestValue>("job:backfill:991001")).data
						.scanId,
				).toBe("301");
			});
		},
	);
	it("records a delayed older reset without rewinding a newer scan", async () => {
		const stub = gateway();
		await admit(stub, {
			guildId: "991001",
			limit: 500,
			reset: true,
			interactionId: "502",
		});
		await admit(stub, {
			guildId: "991001",
			limit: 100,
			reset: true,
			interactionId: "501",
		});
		expect((await current(stub)).data.scanId).toBe("502");
		await inside(stub, async (_, state) =>
			expect(await state.storage.get("backfill-admission:501")).toBeDefined(),
		);
	});

	it("does not award users returned by a stale in-flight reaction page after reset", async () => {
		const stub = gateway();
		await admit(stub, { guildId: "991001", interactionId: "400" });
		await inside(stub, async (_, state) => {
			const job = await state.storage.get<TestValue>("job:backfill:991001");
			job.data.channelIds = ["991002"];
			job.data.message = {
				...message,
				id: "stale-message",
				author: { id: "stale-author", bot: false },
			};
			await state.storage.put("job:backfill:991001", job);
		});
		let release!: () => void;
		let requested!: () => void;
		const waiting = new Promise<void>((resolve) => {
			requested = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				requested();
				await held;
				return Response.json([{ id: "991006", bot: false }]);
			}),
		);
		await inside(stub, async (instance, state) => {
			const running = instance.alarm();
			await waiting;
			await instance.fetch(
				new Request("https://gateway/backfill", {
					method: "POST",
					body: JSON.stringify({
						guildId: "991001",
						reset: true,
						interactionId: "401",
					}),
				}),
			);
			release();
			await running;
			expect(
				(await state.storage.get<TestValue>("job:backfill:991001")).data.scanId,
			).toBe("401");
		});
		expect(
			(await new Database(env.DB).getBalance("stale-author")).balanceUnits,
		).toBe(0);
	});
});
