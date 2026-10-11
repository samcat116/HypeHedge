import { env, runInDurableObject } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import type { GatewayDO } from "../../src/cloudflare/gateway";
import type {
	DiscordInteraction,
	InteractionEnv,
} from "../../src/cloudflare/interactions";
import worker from "../../src/cloudflare/worker";
let keys: CryptoKeyPair;
let publicKey: string;
const hex = (bytes: ArrayBuffer) =>
	[...new Uint8Array(bytes)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
beforeAll(async () => {
	keys = (await crypto.subtle.generateKey("Ed25519", true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	publicKey = hex(await crypto.subtle.exportKey("raw", keys.publicKey));
});
const snowflake = (time = Date.now()) =>
	((BigInt(time) - 1420070400000n) << 22n).toString();
function command(extra: Partial<DiscordInteraction> = {}): DiscordInteraction {
	return {
		id: snowflake(),
		application_id: "123",
		token: "fake-valid-token",
		type: 2,
		guild_id: "123",
		member: { user: { id: "456" } },
		data: { name: "balance" },
		...extra,
	};
}
async function signed(data: DiscordInteraction) {
	const body = JSON.stringify(data);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = await crypto.subtle.sign(
		"Ed25519",
		keys.privateKey,
		new TextEncoder().encode(timestamp + body),
	);
	return new Request("https://worker/interactions", {
		method: "POST",
		body,
		headers: {
			"x-signature-ed25519": hex(signature),
			"x-signature-timestamp": timestamp,
		},
	});
}
function environment(
	stub: DurableObjectStub,
	fetchOverride?: typeof stub.fetch,
): InteractionEnv {
	return {
		...env,
		DISCORD_PUBLIC_KEY: publicKey,
		CLIENT_ID: "123",
		GATEWAY: {
			idFromName: () => "test",
			get: () => ({ fetch: fetchOverride ?? stub.fetch.bind(stub) }),
		} as unknown as DurableObjectNamespace,
	} as InteractionEnv;
}
async function inside(
	stub: DurableObjectStub,
	fn: (instance: GatewayDO, state: DurableObjectState) => Promise<void>,
) {
	await (
		runInDurableObject as unknown as (
			stub: DurableObjectStub,
			fn: (instance: GatewayDO, state: DurableObjectState) => Promise<void>,
		) => Promise<void>
	)(stub, fn);
}

it("signed retries distinguish pending, queued reply and delivered retained result", async () => {
	const stub = env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
	const bindings = environment(stub);
	const data = command({
		type: 5,
		data: {
			custom_id: "market:create:binary",
			components: [
				{
					type: 1,
					components: [
						{
							type: 4,
							custom_id: "description",
							value: "Signed replay market",
						},
					],
				},
			],
		},
	});
	expect(
		await (await worker.fetch(await signed(data), bindings)).json(),
	).toEqual({ type: 5, data: { flags: 64 } });
	expect(
		await (await worker.fetch(await signed(data), bindings)).json(),
	).toEqual({ type: 5, data: { flags: 64 } });
	await inside(stub, async (instance, state) => {
		await state.storage.deleteAlarm();
		await instance.alarm();
		await state.storage.deleteAlarm();
	});
	const reply = (await (
		await worker.fetch(await signed(data), bindings)
	).json()) as { type: number; data: { content: string; flags: number } };
	expect(reply.type).toBe(4);
	expect(reply.data.content).toContain("Signed replay market");
	expect(reply.data.flags).toBe(64);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({})),
	);
	try {
		await inside(stub, async (instance, state) => {
			await state.storage.deleteAlarm();
			await instance.alarm();
			await state.storage.deleteAlarm();
			expect((await state.storage.list({ prefix: "job:" })).size).toBe(0);
		});
	} finally {
		vi.unstubAllGlobals();
	}
	expect(
		await (await worker.fetch(await signed(data), bindings)).json(),
	).toEqual(reply);
	await inside(stub, async (_instance, state) => {
		expect((await state.storage.list({ prefix: "job:" })).size).toBe(0);
	});
	expect(
		await env.DB.prepare(
			"SELECT count(*) AS total FROM markets WHERE description=?",
		)
			.bind("Signed replay market")
			.first<number>("total"),
	).toBe(1);
});

it("deadline503 does not cancel a late durable capture and its signed retry recovers", async () => {
	const stub = env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
	const data = command();
	let resolveCapture: () => void = () => {};
	const finished = new Promise<void>((resolve) => {
		resolveCapture = resolve;
	});
	const delayedFetch = (async (url: RequestInfo, init?: RequestInit) => {
		await new Promise((resolve) => setTimeout(resolve, 2550));
		const response = await stub.fetch(url, init);
		resolveCapture();
		return response;
	}) as typeof stub.fetch;
	expect(
		(await worker.fetch(await signed(data), environment(stub, delayedFetch)))
			.status,
	).toBe(503);
	await finished;
	await inside(stub, async (_instance, state) => {
		await state.storage.deleteAlarm();
		expect((await state.storage.list({ prefix: "job:" })).size).toBe(1);
	});
	expect(
		await (await worker.fetch(await signed(data), environment(stub))).json(),
	).toEqual({ type: 5, data: { flags: 64 } });
});

it("valid signatures cannot change captured tokens or payloads and invalid signatures cannot reach intake", async () => {
	const stub = env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
	const bindings = environment(stub);
	const data = command();
	expect((await worker.fetch(await signed(data), bindings)).status).toBe(200);
	expect(
		(
			await worker.fetch(
				await signed({ ...data, token: "different-token" }),
				bindings,
			)
		).status,
	).toBe(409);
	expect(
		(
			await worker.fetch(
				await signed({ ...data, data: { name: "leaderboard" } }),
				bindings,
			)
		).status,
	).toBe(409);
	const request = await signed(data);
	const invalid = new Request(request.url, {
		method: "POST",
		headers: request.headers,
		body: JSON.stringify({ ...data, token: "different-token" }),
	});
	expect((await worker.fetch(invalid, bindings)).status).toBe(401);
	await inside(stub, async (_instance, state) => {
		await state.storage.deleteAlarm();
		expect((await state.storage.list({ prefix: "job:" })).size).toBe(1);
	});
});

it("evicted expired identities fail closed instead of creating a command with no viable reply", async () => {
	const stub = env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
	const old = command({ id: snowflake(Date.now() - 86400001) });
	await inside(stub, async (_instance, state) => {
		await state.storage.put(`seen:command:${old.id}`, {
			time: Date.now(),
			payload: JSON.stringify(old),
			result: { content: "Retained completed result" },
			delivery: "expired",
		});
	});
	expect(
		await (await worker.fetch(await signed(old), environment(stub))).json(),
	).toEqual({
		type: 4,
		data: {
			content: "Retained completed result",
			flags: 64,
			allowed_mentions: { parse: [] },
		},
	});
	await inside(stub, async (_instance, state) => {
		await state.storage.delete(`seen:command:${old.id}`);
	});
	expect(
		(await worker.fetch(await signed(old), environment(stub))).status,
	).toBe(410);
	await inside(stub, async (_instance, state) => {
		expect((await state.storage.list({ prefix: "job:" })).size).toBe(0);
	});
});

it("capture responses are bounded, parsed and mapped without trusting malformed completion bodies", async () => {
	const stub = env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
	const data = command();
	for (const response of [
		new Response("x".repeat(65537)),
		Response.json({ state: "completed" }),
		Response.json({ state: "unknown" }),
	]) {
		const fake = (async () => response) as typeof stub.fetch;
		expect(
			(await worker.fetch(await signed(data), environment(stub, fake))).status,
		).toBe(503);
	}
	let cancelled = false;
	const stream = new ReadableStream({
		cancel() {
			cancelled = true;
		},
	});
	const fake = (async () => new Response(stream)) as typeof stub.fetch;
	expect(
		(await worker.fetch(await signed(data), environment(stub, fake))).status,
	).toBe(503);
	expect(cancelled).toBe(true);
});
