import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type DiscordInteraction,
	type InteractionEnv,
	executeInteraction,
	immediateInteraction,
} from "../../src/cloudflare/interactions";
import worker, { verifyDiscordRequest } from "../../src/cloudflare/worker";

let keys: CryptoKeyPair;
let publicKey: string;
const hex = (data: ArrayBuffer) =>
	[...new Uint8Array(data)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
beforeAll(async () => {
	keys = (await crypto.subtle.generateKey("Ed25519", true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	publicKey = hex(await crypto.subtle.exportKey("raw", keys.publicKey));
});
const interaction = (
	extra: Partial<DiscordInteraction> = {},
): DiscordInteraction => ({
	id: "12345",
	application_id: "client123",
	token: "test-token",
	type: 2,
	guild_id: "123",
	member: { user: { id: "456" }, permissions: "0" },
	data: { name: "balance" },
	...extra,
});
async function signed(
	body: string,
	timestamp = String(Math.floor(Date.now() / 1000)),
) {
	const signature = await crypto.subtle.sign(
		"Ed25519",
		keys.privateKey,
		new TextEncoder().encode(timestamp + body),
	);
	return new Request("https://worker/interactions", {
		method: "POST",
		headers: {
			"x-signature-ed25519": hex(signature),
			"x-signature-timestamp": timestamp,
		},
		body,
	});
}
const testEnv = () =>
	({
		...env,
		DISCORD_PUBLIC_KEY: publicKey,
		CLIENT_ID: "client123",
	}) as unknown as InteractionEnv;
describe("signed interactions in workerd", () => {
	it("verifies raw bytes, rejects tampering, stale and malformed signatures", async () => {
		const body = JSON.stringify({ type: 1 });
		expect(
			await verifyDiscordRequest(await signed(body), publicKey),
		).not.toBeNull();
		const request = await signed(body);
		const tampered = new Request(request.url, {
			method: "POST",
			headers: request.headers,
			body: `${body} `,
		});
		expect(await verifyDiscordRequest(tampered, publicKey)).toBeNull();
		expect(
			await verifyDiscordRequest(
				await signed(body, String(Math.floor(Date.now() / 1000) - 301)),
				publicKey,
			),
		).toBeNull();
		expect(await verifyDiscordRequest(await signed(body), "bad")).toBeNull();
	});
	it("answers PING immediately and rejects wrong application and JSON", async () => {
		expect(
			await (await worker.fetch(await signed('{"type":1}'), testEnv())).json(),
		).toEqual({ type: 1 });
		expect(
			(
				await worker.fetch(
					await signed(
						JSON.stringify(interaction({ application_id: "other" })),
					),
					testEnv(),
				)
			).status,
		).toBe(400);
		expect((await worker.fetch(await signed("{"), testEnv())).status).toBe(400);
	});
	it("does not defer when durable capture fails", async () => {
		const badEnv = {
			...testEnv(),
			GATEWAY: {
				idFromName: () => "fake",
				get: () => ({
					fetch: async () => new Response("full", { status: 503 }),
				}),
			},
		} as unknown as InteractionEnv;
		expect(
			(await worker.fetch(await signed(JSON.stringify(interaction())), badEnv))
				.status,
		).toBe(503);
	});
	it("capture is complete before returning the deferred acknowledgement", async () => {
		let captured = false;
		const fake = {
			...testEnv(),
			GATEWAY: {
				idFromName: () => "fake",
				get: () => ({
					fetch: async (_url: unknown, init: RequestInit) => {
						expect(JSON.parse(String(init.body)).id).toBe("12345");
						captured = true;
						return Response.json({ state: "pending" });
					},
				}),
			},
		} as unknown as InteractionEnv;
		const result = await worker.fetch(
			await signed(JSON.stringify(interaction())),
			fake,
		);
		expect(captured).toBe(true);
		expect(await result.json()).toEqual({ type: 5, data: { flags: 64 } });
	});
	it("rejects non-admin backfill and direct-message interactions", async () => {
		expect(
			(
				await immediateInteraction(
					interaction({ data: { name: "backfill" } }),
					testEnv(),
				)
			)?.type,
		).toBe(4);
		expect(
			(
				await immediateInteraction(
					interaction({ guild_id: undefined }),
					testEnv(),
				)
			)?.type,
		).toBe(4);
	});
	it("opens create modals immediately and provides an empty scoped autocomplete", async () => {
		const create = interaction({
			data: {
				name: "market",
				options: [
					{ name: "create", type: 2, options: [{ name: "multi", type: 1 }] },
				],
			},
		});
		expect((await immediateInteraction(create, testEnv()))?.type).toBe(9);
		const autocomplete = interaction({
			type: 4,
			data: {
				name: "market",
				options: [{ name: "market", type: 3, value: "", focused: true }],
			},
		});
		expect(await immediateInteraction(autocomplete, testEnv())).toEqual({
			type: 8,
			data: { choices: [] },
		});
	});
	it("validates malformed modal values without touching accounting", async () => {
		const invalid = interaction({
			type: 5,
			data: {
				custom_id: "market:create:multi",
				components: [
					{
						type: 1,
						components: [
							{ type: 4, custom_id: "description", value: "Test" },
							{ type: 4, custom_id: "options", value: "a,a" },
						],
					},
				],
			},
		});
		expect((await executeInteraction(invalid, testEnv())).content).toContain(
			"distinct choices",
		);
	});
});

it("replayed create modal has one durable D1 effect; cross-guild view/order/resolve cannot access it", async () => {
	const create = interaction({
		id: "9191",
		type: 5,
		data: {
			custom_id: "market:create:binary",
			components: [
				{
					type: 1,
					components: [
						{ type: 4, custom_id: "description", value: "Will it rain?" },
					],
				},
			],
		},
	});
	const first = await executeInteraction(create, testEnv());
	const second = await executeInteraction(create, testEnv());
	expect(second).toEqual(first);
	const markets = await env.DB.prepare(
		"SELECT id FROM markets WHERE guild_id=?",
	)
		.bind("123")
		.all<{ id: string }>();
	expect(markets.results).toHaveLength(1);
	const id = markets.results[0].id;
	for (const name of ["view", "order", "resolve", "cancel"]) {
		const result = await executeInteraction(
			interaction({
				guild_id: "999",
				data: {
					name: "market",
					options: [
						{
							name,
							type: 1,
							options: [{ name: "market", type: 3, value: id }],
						},
					],
				},
			}),
			testEnv(),
		);
		expect(result.content).toContain("not found in this server");
	}
	const choices = await immediateInteraction(
		interaction({
			guild_id: "999",
			type: 4,
			data: {
				name: "market",
				options: [{ name: "market", type: 3, value: "", focused: true }],
			},
		}),
		testEnv(),
	);
	expect(choices).toEqual({ type: 8, data: { choices: [] } });
	const unauthorized = await executeInteraction(
		interaction({
			member: { user: { id: "888" } },
			data: {
				name: "market",
				options: [
					{
						name: "resolve",
						type: 1,
						options: [{ name: "market", type: 3, value: id }],
					},
				],
			},
		}),
		testEnv(),
	);
	expect(unauthorized.content).toContain("not the oracle");
});

it("quick-order button opens modal, validates its submission, and emits bounded pagination", async () => {
	const { Database } = await import("../../src/database");
	const db = new Database(env.DB);
	const market = await db.createMarket(
		{
			guildId: "123",
			creatorId: "456",
			oracleUserId: "456",
			description: "Button market",
			outcomeDescriptions: ["Yes", "No"],
		},
		"buttons-market",
	);
	const custom = `market:quickorder:${market.id}:${market.outcomes[0].id}`;
	const opened = await immediateInteraction(
		interaction({ type: 3, data: { custom_id: custom } }),
		testEnv(),
	);
	expect(opened?.type).toBe(9);
	const submitted = await executeInteraction(
		interaction({
			type: 5,
			data: {
				custom_id: `market:quickorder:confirm:${market.id}:${market.outcomes[0].id}`,
				components: [
					{
						type: 1,
						components: [
							{ type: 4, custom_id: "direction", value: "buy" },
							{ type: 4, custom_id: "quantity", value: "1.5" },
							{ type: 4, custom_id: "price", value: "0.5" },
						],
					},
				],
			},
		}),
		testEnv(),
	);
	expect(submitted.content).toContain("Invalid outcome");
	const pages = await executeInteraction(
		interaction({ type: 3, data: { custom_id: "markets:next:0:open" } }),
		testEnv(),
	);
	expect(pages.components).toHaveLength(1);
	const badPage = await executeInteraction(
		interaction({ type: 3, data: { custom_id: "markets:next:Infinity" } }),
		testEnv(),
	);
	expect(badPage.content).toBe("Invalid page.");
});

it("slow immediate responses finish before Discord deadline and cron only recovers", async () => {
	const fakeDB = {
		prepare: () => ({ bind: () => ({ all: () => new Promise(() => {}) }) }),
	} as unknown as D1Database;
	const start = Date.now();
	const result = await worker.fetch(
		await signed(
			JSON.stringify(
				interaction({
					type: 4,
					data: {
						name: "market",
						options: [{ name: "market", type: 3, value: "", focused: true }],
					},
				}),
			),
		),
		{ ...testEnv(), DB: fakeDB },
	);
	expect(await result.json()).toEqual({ type: 8, data: { choices: [] } });
	expect(Date.now() - start).toBeLessThan(2000);
	let path = "";
	await worker.scheduled({} as ScheduledController, {
		...testEnv(),
		GATEWAY: {
			idFromName: () => "fake",
			get: () => ({
				fetch: async (url: string) => {
					path = url;
					return new Response("ok");
				},
			}),
		} as unknown as DurableObjectNamespace,
	});
	expect(path).toBe("https://gateway/recover");
});

it("expected input errors become durable reply jobs while transient database failures propagate", async () => {
	const bad = interaction({
		id: (BigInt(Date.now() - 1420070400000) << 22n).toString(),
		type: 3,
		data: { custom_id: "market:resolve:unknown", values: ["missing"] },
	});
	const stub = env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
	await (
		runInDurableObject as unknown as (
			stub: DurableObjectStub,
			fn: (
				instance: { process: (job: unknown) => Promise<boolean> },
				state: DurableObjectState,
			) => Promise<void>,
		) => Promise<void>
	)(stub, async (instance) => {
		const job = {
			kind: "command",
			id: `command:${bad.id}`,
			data: bad,
			attempts: 0,
			due: Date.now(),
		};
		expect(await instance.process(job)).toBe(false);
		expect(job.kind).toBe("reply");
		expect(
			(job.data as unknown as { payload: { content: string } }).payload.content,
		).toContain("not found in this server");
		expect(job.attempts).toBe(0);
	});
	const malformed = interaction({
		data: { name: "market", options: "malformed" as unknown as [] },
	});
	expect((await executeInteraction(malformed, testEnv())).content).toContain(
		"Invalid interaction controls",
	);
	const failingDB = {
		prepare: () => ({
			bind: () => ({ all: () => Promise.reject(new Error("D1 unavailable")) }),
		}),
	} as unknown as D1Database;
	await expect(
		executeInteraction(bad, { ...testEnv(), DB: failingDB }),
	).rejects.toThrow("D1 unavailable");
});

it.each([
	["binary", ["Yes", "No"]],
	["multiple choice", ["Team A", "Team B", "Team C"]],
] as const)(
	"market view identifies outcomes in otherwise identical %s buy and sell orders",
	async (kind, descriptions) => {
		const { Database } = await import("../../src/database");
		const db = new Database(env.DB);
		const market = await db.createMarket({
			guildId: "123",
			creatorId: "456",
			oracleUserId: "456",
			description: `${kind} order book`,
			outcomeDescriptions: [...descriptions],
		});
		const view = () =>
			executeInteraction(
				interaction({
					data: {
						name: "market",
						options: [
							{
								name: "view",
								type: 1,
								options: [{ name: "market", type: 3, value: market.id }],
							},
						],
					},
				}),
				testEnv(),
			);
		const empty = await view();
		expect(empty.content).toContain("No active orders.");
		const controls = (
			empty.components as {
				components: { custom_id: string; label: string }[];
			}[]
		).flatMap((row) => row.components);
		expect(controls.map((control) => control.custom_id)).toEqual(
			market.outcomes.map(
				(outcome) => `market:quickorder:${market.id}:${outcome.id}`,
			),
		);
		expect(controls.map((control) => control.label)).toEqual([...descriptions]);
		for (const outcome of market.outcomes) {
			for (const direction of ["buy", "sell"] as const) {
				const user = `${kind}-${outcome.id}-${direction}`;
				for (let credit = 0; credit < 3; credit++)
					await db.addReaction(`${user}-${credit}`, "reactor", user, "x");
				expect(
					(
						await db.createOrder(
							user,
							market.id,
							outcome.id,
							direction,
							2,
							5000,
						)
					).success,
				).toBe(true);
			}
		}
		const populated = await view();
		for (const description of descriptions) {
			expect(populated.content?.split("\n")).toContain(
				`${description}: buy 2 @ 50%`,
			);
			expect(populated.content?.split("\n")).toContain(
				`${description}: sell 2 @ 50%`,
			);
		}
		expect(populated.components).toEqual(empty.components);
		expect(
			(
				await executeInteraction(
					interaction({
						guild_id: "999",
						data: {
							name: "market",
							options: [
								{
									name: "view",
									type: 1,
									options: [{ name: "market", type: 3, value: market.id }],
								},
							],
						},
					}),
					testEnv(),
				)
			).content,
		).toBe("Market not found in this server.");
	},
);

it("market view bounds long outcome labels without removing order details", async () => {
	const { Database } = await import("../../src/database");
	const db = new Database(env.DB);
	const description = "A".repeat(100);
	const market = await db.createMarket({
		guildId: "123",
		creatorId: "456",
		oracleUserId: "456",
		description: "Long labels",
		outcomeDescriptions: [description, "Other"],
	});
	await db.addReaction("long-label-credit", "reactor", "long-label-buyer", "x");
	expect(
		(
			await db.createOrder(
				"long-label-buyer",
				market.id,
				market.outcomes[0].id,
				"buy",
				1,
				2500,
			)
		).success,
	).toBe(true);
	const result = await executeInteraction(
		interaction({
			data: {
				name: "market",
				options: [
					{
						name: "view",
						type: 1,
						options: [{ name: "market", type: 3, value: market.id }],
					},
				],
			},
		}),
		testEnv(),
	);
	expect(result.content?.split("\n")).toContain(
		`#1 ${"A".repeat(74)}...: buy 1 @ 25%`,
	);
});

it("market view distinguishes long outcome labels with a shared prefix", async () => {
	const { Database } = await import("../../src/database");
	const db = new Database(env.DB);
	const prefix = "Shared prefix ".repeat(6);
	const market = await db.createMarket({
		guildId: "123",
		creatorId: "456",
		oracleUserId: "456",
		description: "Shared prefixes",
		outcomeDescriptions: [`${prefix}first`, `${prefix}second`],
	});
	for (const outcome of market.outcomes) {
		const user = `shared-prefix-${outcome.number}`;
		await db.addReaction(user, "reactor", user, "x");
		expect(
			(await db.createOrder(user, market.id, outcome.id, "buy", 1, 2500))
				.success,
		).toBe(true);
	}
	const result = await executeInteraction(
		interaction({
			data: {
				name: "market",
				options: [
					{
						name: "view",
						type: 1,
						options: [{ name: "market", type: 3, value: market.id }],
					},
				],
			},
		}),
		testEnv(),
	);
	const labels = [
		`#1 ${prefix.slice(0, 74)}...`,
		`#2 ${prefix.slice(0, 74)}...`,
	];
	for (const label of labels) {
		expect(label).toHaveLength(80);
		expect(result.content?.split("\n")).toContain(`${label}: buy 1 @ 25%`);
	}
	expect(labels[0]).not.toBe(labels[1]);
	const controls = (
		result.components as {
			components: { custom_id: string; label: string }[];
		}[]
	).flatMap((row) => row.components);
	expect(controls.map((control) => control.label)).toEqual(labels);
	expect(controls.map((control) => control.custom_id)).toEqual(
		market.outcomes.map(
			(outcome) => `market:quickorder:${market.id}:${outcome.id}`,
		),
	);
});
