import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
// biome-ignore lint/suspicious/noExplicitAny: Failure injection observes private durable command transitions.
type Value = any;
function gateway() {
	return env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
}
function snowflake(offset = 0) {
	return (
		(BigInt(Date.now() + offset - 1420070400000) << 22n) +
		25n
	).toString();
}
function command(id = snowflake()) {
	return {
		id,
		token: "replay-token",
		application_id: env.CLIENT_ID,
		type: 2,
		guild_id: "772001",
		user: { id: "772002" },
		data: { name: "balance" },
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
	return new Response(await response.text(), {
		status: response.status,
		headers: response.headers,
	});
}
async function tick(stub: DurableObjectStub) {
	await inside(stub, async (instance, state) => {
		for (const [key, job] of await state.storage.list<Value>({
			prefix: "job:",
		})) {
			job.due = 0;
			await state.storage.put(key, job);
		}
		await state.storage.delete("restPause");
		await instance.alarm();
	});
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
it("retains completed mutation result atomically with outbox and after delivery/eviction", async () => {
	const stub = gateway();
	const input = {
		...command(),
		type: 5,
		guild_id: "772101",
		data: {
			custom_id: "market:create:binary",
			components: [
				{
					type: 1,
					components: [
						{ type: 4, custom_id: "description", value: "Replay prediction" },
					],
				},
			],
		},
	};
	const fetch = vi.fn(async () => new Response(null, { status: 204 }));
	vi.stubGlobal("fetch", fetch);
	expect(await (await admit(stub, input)).json()).toEqual({ state: "pending" });
	await tick(stub);
	const first = await (await admit(stub, input)).json<Value>();
	expect(first.state).toBe("completed");
	expect(first.payload.content).toContain("Replay prediction");
	await tick(stub);
	await evictDurableObject(stub);
	expect(await (await admit(stub, input)).json()).toEqual(first);
	expect(
		(
			await env.DB.prepare(
				"SELECT id FROM markets WHERE guild_id='772101'",
			).all()
		).results,
	).toHaveLength(1);
	expect(fetch).toHaveBeenCalledTimes(1);
	await inside(stub, async (_, state) =>
		expect((await state.storage.list({ prefix: "job:" })).size).toBe(0),
	);
	expect((await admit(stub, { ...input, token: "other-token" })).status).toBe(
		409,
	);
	expect((await admit(stub, { ...input, user: { id: "772003" } })).status).toBe(
		409,
	);
});
it.each(["expired", "forbidden", "deleted"])(
	"retains result after terminal %s reply",
	async (mode) => {
		const stub = gateway();
		const input = command();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({}, { status: mode === "forbidden" ? 403 : 404 }),
			),
		);
		await admit(stub, input);
		await tick(stub);
		if (mode === "expired")
			await inside(stub, async (_, state) => {
				const key = `job:command:${input.id}`;
				const job = await state.storage.get<Value>(key);
				job.data.expiresAt = 0;
				await state.storage.put(key, job);
			});
		await tick(stub);
		await evictDurableObject(stub);
		expect((await (await admit(stub, input)).json<Value>()).state).toBe(
			"completed",
		);
		await inside(stub, async (_, state) => {
			expect(
				await state.storage.get(`job:command:${input.id}`),
			).toBeUndefined();
			expect(
				(await state.storage.get<Value>(`seen:command:${input.id}`)).delivery,
			).toBe(mode === "expired" ? "expired" : "unavailable");
		});
	},
);
it("never defers orphaned receipt and rejects expired uncaptured interaction", async () => {
	const stub = gateway();
	const input = command();
	await inside(stub, async (_, state) => {
		await state.storage.put(`seen:command:${input.id}`, {
			time: Date.now(),
			payload: JSON.stringify(input),
		});
	});
	expect((await (await admit(stub, input)).json<Value>()).state).toBe(
		"completed",
	);
	expect((await admit(stub, command(snowflake(-16 * 60 * 1000)))).status).toBe(
		410,
	);
	await inside(stub, async (_, state) =>
		expect((await state.storage.list({ prefix: "job:" })).size).toBe(0),
	);
});
it("cleanup preserves admitted pending commands and expires completed receipts without recapture", async () => {
	const stub = gateway();
	const input = command();
	await admit(stub, input);
	const origin = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(origin + 86400001);
	await tick(stub);
	await tick(stub);
	await tick(stub);
	expect((await admit(stub, input)).status).toBe(410);
	await inside(stub, async (_, state) =>
		expect((await state.storage.list({ prefix: "job:" })).size).toBe(0),
	);
});
it("completed reset command replay cannot replace a newer backfill scan", async () => {
	const stub = gateway();
	const input = {
		...command(),
		guild_id: "772301",
		member: { user: { id: "772002" }, permissions: "8" },
		data: {
			name: "backfill",
			options: [{ name: "reset", type: 5, value: true }],
		},
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("Offline"))),
	);
	await admit(stub, input);
	await tick(stub);
	const newId = (BigInt(input.id) + 1n).toString();
	const reset = await stub.fetch("https://gateway/backfill", {
		method: "POST",
		body: JSON.stringify({
			guildId: input.guild_id,
			reset: true,
			interactionId: newId,
		}),
	});
	await reset.text();
	await evictDurableObject(stub);
	expect((await (await admit(stub, input)).json<Value>()).state).toBe(
		"completed",
	);
	await inside(stub, async (_, state) =>
		expect(
			(await state.storage.get<Value>(`job:backfill:${input.guild_id}`)).data
				.scanId,
		).toBe(newId),
	);
});
it("bounds retained records and admits existing replays despite retention saturation", async () => {
	const stub = gateway();
	const input = command();
	await admit(stub, input);
	await inside(stub, async (_, state) => {
		await state.storage.put("command-record-count", 4096);
	});
	expect(
		(await admit(stub, command((BigInt(input.id) + 1n).toString()))).status,
	).toBe(503);
	expect(await (await admit(stub, input)).json()).toEqual({ state: "pending" });
});
it("cleanup advances past protected prefix records and eventually reclaims expired completed records", async () => {
	const stub = gateway();
	const origin = Date.now();
	await inside(stub, async (_, state) => {
		const rows: Record<string, Value> = {};
		for (let n = 0; n < 128; n++) {
			const id = `command:${String(n).padStart(4, "0")}`;
			rows[`seen:${id}`] = { time: origin - 86400001, payload: "pending" };
			rows[`job:${id}`] = {
				kind: "command",
				id,
				data: {},
				due: origin + 100000,
				attempts: 0,
			};
		}
		rows["seen:command:9999"] = {
			time: origin - 86400001,
			payload: "complete",
			result: { content: "Done" },
		};
		rows["command-record-count"] = 129;
		await state.storage.put(rows);
	});
	await inside(stub, async (instance, state) => {
		await instance.alarm();
		expect(await state.storage.get("seen:command:9999")).toBeDefined();
		await instance.alarm();
		expect(await state.storage.get("seen:command:9999")).toBeUndefined();
		expect((await state.storage.list({ prefix: "seen:" })).size).toBe(128);
		expect(await state.storage.get("command-record-count")).toBe(128);
	});
});
it("crash after committed command effect before durable result write retries its receipt without a second mutation", async () => {
	const stub = gateway();
	const input = {
		...command(),
		type: 5,
		guild_id: "772401",
		data: {
			custom_id: "market:create:binary",
			components: [
				{
					type: 1,
					components: [
						{
							type: 4,
							custom_id: "description",
							value: "Committed before crash",
						},
					],
				},
			],
		},
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 204 })),
	);
	await admit(stub, input);
	await inside(stub, async (instance, state) => {
		instance.saveJob = async () => {
			throw new Error("Simulated durable-write outage");
		};
		await expect(instance.alarm()).rejects.toThrow(
			"Simulated durable-write outage",
		);
		expect(
			(await state.storage.get<Value>(`job:command:${input.id}`)).kind,
		).toBe("command");
		expect(
			(await state.storage.get<Value>(`seen:command:${input.id}`)).result,
		).toBeUndefined();
	});
	expect(
		(
			await env.DB.prepare(
				"SELECT id FROM markets WHERE guild_id='772401'",
			).all()
		).results,
	).toHaveLength(1);
	await evictDurableObject(stub);
	await tick(stub);
	const result = await (await admit(stub, input)).json<Value>();
	expect(result.state).toBe("completed");
	expect(result.payload.content).toContain("Committed before crash");
	expect(
		(
			await env.DB.prepare(
				"SELECT id FROM markets WHERE guild_id='772401'",
			).all()
		).results,
	).toHaveLength(1);
});
it("never overwrites an orphaned existing command when its admission receipt is missing", async () => {
	const stub = gateway();
	const input = command();
	const job = {
		kind: "command",
		id: `command:${input.id}`,
		data: { ...input, token: "original-token" },
		attempts: 3,
		due: Date.now() + 60000,
	};
	await inside(stub, async (_, state) => {
		await state.storage.put(`job:command:${input.id}`, job);
	});
	expect((await admit(stub, input)).status).toBe(409);
	await inside(stub, async (_, state) => {
		expect(await state.storage.get(`job:command:${input.id}`)).toEqual(job);
		expect(await state.storage.get(`seen:command:${input.id}`)).toBeUndefined();
	});
});
