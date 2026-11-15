import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import type { GatewayDO } from "../../src/cloudflare/gateway";
import { Database } from "../../src/database";
// biome-ignore lint/suspicious/noExplicitAny: White-box tests inspect private durable job JSON.
type Job = any;
const commandId = () =>
	((BigInt(Date.now()) - 1420070400000n) << 22n).toString();
function gateway() {
	return env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
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
async function seed(stub: DurableObjectStub) {
	const id = commandId();
	await inside(stub, async (_instance, state) => {
		await state.storage.put({
			"scheduler-lane": 3,
			"job:backfill:limited": {
				kind: "backfill",
				id: "backfill:limited",
				attempts: 0,
				due: 0,
				data: {
					guildId: "123",
					scanId: "limit-scan",
					channelIds: ["limited"],
					channelIndex: 0,
					limit: 1000,
					scanned: 0,
				},
			},
			[`job:command:${id}`]: {
				kind: "command",
				id: `command:${id}`,
				attempts: 0,
				due: 0,
				data: {
					id,
					application_id: "123",
					token: "command-token",
					type: 2,
					guild_id: "123",
					member: { user: { id: "456" } },
					data: { name: "balance" },
				},
			},
			"job:reply:independent": {
				kind: "reply",
				id: "reply:independent",
				attempts: 0,
				due: 0,
				data: {
					applicationId: "123",
					token: "reply-token",
					payload: { content: "reply" },
					expiresAt: Date.now() + 600000,
				},
			},
			"job:event:live": {
				kind: "event",
				id: "event:live",
				attempts: 0,
				due: 0,
				data: {
					op: 0,
					t: "MESSAGE_REACTION_ADD",
					d: {
						guild_id: "123",
						channel_id: "live",
						message_id: "live-message",
						user_id: "789",
						member: { user: { id: "789", bot: false } },
						emoji: { name: "x" },
					},
				},
			},
		});
		await state.storage.deleteAlarm();
	});
	return id;
}
function fake429(response: () => Response) {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo) => {
			const path = new URL(String(input)).pathname;
			calls.push(path);
			if (path.includes("/channels/limited/")) return response();
			if (path.includes("/channels/live/"))
				return Response.json({ author: { id: "888", bot: false } });
			if (path.includes("/webhooks/"))
				return new Response(null, { status: 204 });
			throw new Error(`Unexpected route ${path}`);
		}),
	);
	return calls;
}
afterEach(() => vi.unstubAllGlobals());
it("non-global429 delays only its backfill while commands, replies and a live event progress", async () => {
	const stub = gateway();
	const id = await seed(stub);
	const calls = fake429(() =>
		Response.json({ retry_after: 5, global: false }, { status: 429 }),
	);
	await inside(stub, async (instance, state) => {
		await instance.alarm();
		await state.storage.deleteAlarm();
		const limited = await state.storage.get<Job>("job:backfill:limited");
		expect(limited.attempts).toBe(1);
		expect(limited.due).toBeGreaterThanOrEqual(Date.now() + 4500);
		expect((await state.storage.get<Job>(`job:command:${id}`)).kind).toBe(
			"reply",
		);
		expect(await state.storage.get("restPause")).toBeUndefined();
		expect(await state.storage.get("job:reply:independent")).toBeUndefined();
		expect(await state.storage.get("job:event:live")).toBeUndefined();
	});
	expect((await new Database(env.DB).getBalance("888")).balanceUnits).toBe(
		10000,
	);
	expect(calls).toHaveLength(3);
	await inside(stub, async (instance, state) => {
		await instance.alarm();
		await state.storage.deleteAlarm();
		expect(await state.storage.get(`job:command:${id}`)).toBeUndefined();
		expect(
			(await state.storage.get<Job>("job:backfill:limited")).attempts,
		).toBe(1);
	});
	expect(calls.filter((path) => path.includes("limited"))).toHaveLength(1);
});
it.each(["body", "header", "scope"])(
	"true global429 via %s pauses every REST lane until the global deadline",
	async (signal) => {
		const stub = gateway();
		const beforeBalance = (await new Database(env.DB).getBalance("888"))
			.balanceUnits;
		const id = await seed(stub);
		const calls = fake429(() =>
			Response.json(
				{ retry_after: 5, global: signal === "body" },
				{
					status: 429,
					headers:
						signal === "header"
							? { "X-RateLimit-Global": "true" }
							: signal === "scope"
								? { "X-RateLimit-Scope": "global" }
								: {},
				},
			),
		);
		await inside(stub, async (instance, state) => {
			await instance.alarm();
			await state.storage.deleteAlarm();
			expect(await state.storage.get<number>("restPause")).toBeGreaterThan(
				Date.now() + 4500,
			);
			expect((await state.storage.get<Job>(`job:command:${id}`)).kind).toBe(
				"command",
			);
			expect(await state.storage.get("job:reply:independent")).toBeDefined();
			expect(await state.storage.get("job:event:live")).toBeDefined();
			await instance.alarm();
			await state.storage.deleteAlarm();
		});
		expect(calls).toHaveLength(1);
		expect((await new Database(env.DB).getBalance("888")).balanceUnits).toBe(
			beforeBalance,
		);
	},
);
it("malformed global429 uses headers for global classification and Retry-After", async () => {
	const stub = gateway();
	await seed(stub);
	const calls = fake429(
		() =>
			new Response("invalid JSON", {
				status: 429,
				headers: { "X-RateLimit-Global": "true", "Retry-After": "7" },
			}),
	);
	await inside(stub, async (instance, state) => {
		await instance.alarm();
		await state.storage.deleteAlarm();
		const job = await state.storage.get<Job>("job:backfill:limited");
		expect(job.attempts).toBe(1);
		expect(job.due - Date.now()).toBeGreaterThan(6500);
		expect(await state.storage.get("restPause")).toBe(job.due);
	});
	expect(calls).toHaveLength(1);
});
it.each([
	[-2, undefined, 1000],
	["NaN", "3.5", 3500],
	[7200, undefined, 3600000],
	[0.2, undefined, 1000],
] as const)(
	"repeated route429 has bounded delay for body %s header %s",
	async (retry, header, delay) => {
		const stub = gateway();
		await inside(stub, async (_instance, state) => {
			await state.storage.put("job:backfill:limited", {
				kind: "backfill",
				id: "backfill:limited",
				attempts: 0,
				due: 0,
				data: {
					guildId: "123",
					scanId: "limit-scan",
					channelIds: ["limited"],
					channelIndex: 0,
					limit: 1000,
					scanned: 0,
				},
			});
		});
		const calls = fake429(() =>
			Response.json(
				{ retry_after: retry, global: false },
				{ status: 429, headers: header ? { "Retry-After": header } : {} },
			),
		);
		await inside(stub, async (instance, state) => {
			for (let attempt = 1; attempt <= 3; attempt++) {
				const job = await state.storage.get<Job>("job:backfill:limited");
				job.due = 0;
				await state.storage.put("job:backfill:limited", job);
				await instance.alarm();
				await state.storage.deleteAlarm();
				const saved = await state.storage.get<Job>("job:backfill:limited");
				expect(saved.attempts).toBe(attempt);
				expect(saved.due - Date.now()).toBeGreaterThanOrEqual(delay - 250);
				expect(saved.due - Date.now()).toBeLessThanOrEqual(delay);
				expect(await state.storage.get("restPause")).toBeUndefined();
			}
		});
		expect(calls).toHaveLength(3);
	},
);

it.each([true, false])(
	"startup429 global=%s respects reconnect delay and gates only global drains",
	async (global) => {
		const stub = gateway();
		await inside(stub, async (_instance, state) => {
			await state.storage.put({
				enabled: true,
				"job:reply:startup": {
					kind: "reply",
					id: "reply:startup",
					attempts: 0,
					due: 0,
					data: {
						applicationId: "123",
						token: "startup",
						payload: { content: "reply" },
						expiresAt: Date.now() + 600000,
					},
				},
			});
		});
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo) => {
				const path = new URL(String(input)).pathname;
				calls.push(path);
				if (path.endsWith("/gateway/bot"))
					return Response.json({ retry_after: 12, global }, { status: 429 });
				if (path.includes("/webhooks/"))
					return new Response(null, { status: 204 });
				throw new Error(`Unexpected startup ${path}`);
			}),
		);
		await inside(stub, async (instance, state) => {
			await instance.alarm();
			await state.storage.deleteAlarm();
			expect(
				await state.storage.get<number>("gatewayConnectPause"),
			).toBeGreaterThan(Date.now() + 11500);
			if (global) {
				expect(await state.storage.get<number>("restPause")).toBeGreaterThan(
					Date.now() + 11500,
				);
				expect(await state.storage.get("job:reply:startup")).toBeDefined();
			} else {
				expect(await state.storage.get("restPause")).toBeUndefined();
				expect(await state.storage.get("job:reply:startup")).toBeUndefined();
			}
			await instance.alarm();
			await state.storage.deleteAlarm();
		});
		expect(calls.filter((path) => path.endsWith("/gateway/bot"))).toHaveLength(
			1,
		);
		expect(calls.filter((path) => path.includes("/webhooks/"))).toHaveLength(
			global ? 0 : 1,
		);
	},
);
