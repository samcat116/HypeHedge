import {
	env,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import {
	type DiscordInteraction,
	executeInteraction,
} from "../../src/cloudflare/interactions";
import { Database } from "../../src/database";

const inspect = runInDurableObject as unknown as (
	stub: DurableObjectStub,
	callback: (instance: unknown, state: DurableObjectState) => Promise<void>,
) => Promise<void>;
afterEach(() => vi.unstubAllGlobals());
function interaction(): DiscordInteraction {
	return {
		id: ((BigInt(Date.now() - 1420070400000) << 22n) + 17n).toString(),
		application_id: env.CLIENT_ID,
		token: "fake-recovery-token",
		type: 5,
		guild_id: "741",
		member: { user: { id: "742" } },
		data: {
			custom_id: "market:create:binary",
			components: [
				{
					type: 1,
					components: [
						{ type: 4, custom_id: "description", value: "Recovery test" },
						{ type: 4, custom_id: "oracle", value: "742" },
					],
				},
			],
		},
	};
}
it("recovers a captured command after eviction and a D1 commit before local completion", async () => {
	const i = interaction();
	const db = new Database(env.DB);
	const stub = env.GATEWAY.get(env.GATEWAY.idFromName(crypto.randomUUID()));
	const captured = await stub.fetch("https://gateway/commands", {
		method: "POST",
		body: JSON.stringify(i),
	});
	expect(captured.ok).toBe(true);
	await captured.text();
	// Simulate a crash after remote D1 commit but before replacing the command with its outbox.
	await executeInteraction(i, env);
	await evictDurableObject(stub);
	expect(await runDurableObjectAlarm(stub)).toBe(true);
	await inspect(stub, async (_, state) => {
		const jobs = [
			...(
				await state.storage.list<{ kind: string; attempts: number }>({
					prefix: "job:",
				})
			).values(),
		];
		expect(jobs).toHaveLength(1);
		expect(jobs[0].kind).toBe("reply");
		expect(jobs[0].attempts).toBe(0);
	});
	expect((await db.getGuildMarketsPaginated("741", 0)).totalCount).toBe(1);
	let edits = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			expect(String(url)).toContain(
				"/webhooks/123/fake-recovery-token/messages/@original",
			);
			expect(init?.method).toBe("PATCH");
			edits++;
			return new Response(null, { status: 204 });
		}),
	);
	// PATCH success followed by a crash before delete is safely replayable as the same edit.
	await inspect(stub, async (_, state) => {
		const job = [
			...(
				await state.storage.list<{ data: { payload: unknown } }>({
					prefix: "job:",
				})
			).values(),
		][0];
		await fetch(
			"https://discord.com/api/v10/webhooks/123/fake-recovery-token/messages/@original",
			{ method: "PATCH", body: JSON.stringify(job.data.payload) },
		);
	});
	await evictDurableObject(stub);
	expect(await runDurableObjectAlarm(stub)).toBe(true);
	expect(edits).toBe(2);
	await inspect(stub, async (_, state) => {
		expect((await state.storage.list({ prefix: "job:" })).size).toBe(0);
	});
	expect((await db.getGuildMarketsPaginated("741", 0)).totalCount).toBe(1);
});
