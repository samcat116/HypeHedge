import { D1QueryBudget } from "./d1-budget";
import {
	type DiscordInteraction,
	type InteractionEnv,
	immediateInteraction,
} from "./interactions";
export { GatewayDO } from "./gateway";

const MAX_BODY = 64 * 1024;
const MAX_AGE_SECONDS = 300;
async function captureResult(
	response: Response,
	deadline: number,
): Promise<{
	state: "pending" | "completed";
	payload?: Record<string, unknown>;
}> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing capture response");
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { value, done } = await withinDeadline(
				reader.read(),
				Math.max(1, deadline - Date.now()),
			);
			if (done) break;
			length += value.length;
			if (length > MAX_BODY) throw new Error("Capture response exceeds limit");
			chunks.push(value);
		}
	} finally {
		void reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	const result = JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(bytes),
	);
	if (result?.state !== "pending" && result?.state !== "completed")
		throw new Error("Invalid capture response");
	if (
		result.state === "completed" &&
		(!result.payload ||
			typeof result.payload !== "object" ||
			Array.isArray(result.payload))
	)
		throw new Error("Missing completed result");
	return result;
}
async function withinDeadline<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Interaction deadline exceeded")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function unhex(value: string, bytes: number): Uint8Array<ArrayBuffer> | null {
	if (!new RegExp(`^[a-fA-F0-9]{${bytes * 2}}$`).test(value)) return null;
	return Uint8Array.from(value.match(/../g) ?? [], (part) =>
		Number.parseInt(part, 16),
	);
}

/** Authenticate exactly timestamp + raw bytes, before parsing JSON. */
export async function verifyDiscordRequest(
	request: Request,
	publicKey: string,
	now = Date.now(),
): Promise<Uint8Array | null> {
	const signature = unhex(request.headers.get("x-signature-ed25519") ?? "", 64);
	const keyBytes = unhex(publicKey, 32);
	const timestamp = request.headers.get("x-signature-timestamp") ?? "";
	if (!signature || !keyBytes || !/^\d{1,12}$/.test(timestamp)) return null;
	const seconds = Number(timestamp);
	if (Math.abs(now / 1000 - seconds) > MAX_AGE_SECONDS) return null;
	if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY)
		return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BODY) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const raw = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		raw.set(chunk, offset);
		offset += chunk.length;
	}
	const prefix = new TextEncoder().encode(timestamp);
	const signed = new Uint8Array(prefix.length + raw.length);
	signed.set(prefix);
	signed.set(raw, prefix.length);
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			keyBytes,
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		return (await crypto.subtle.verify("Ed25519", key, signature, signed))
			? raw
			: null;
	} catch {
		return null;
	}
}

export default {
	async scheduled(
		_controller: ScheduledController,
		env: InteractionEnv,
	): Promise<void> {
		const response = await env.GATEWAY.get(
			env.GATEWAY.idFromName("discord"),
		).fetch("https://gateway/recover", { method: "POST" });
		if (!response.ok) throw new Error("Gateway recovery unavailable");
	},
	async fetch(request: Request, bindings: InteractionEnv): Promise<Response> {
		const env = { ...bindings, DB: new D1QueryBudget().wrap(bindings.DB) };
		const deadline = Date.now() + 2400;
		const url = new URL(request.url);
		if (url.pathname !== "/interactions" || request.method !== "POST")
			return new Response("Not found", { status: 404 });
		let raw: Uint8Array | null;
		try {
			raw = await withinDeadline(
				verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY),
				Math.max(1, deadline - Date.now()),
			);
		} catch {
			return new Response("Request deadline exceeded", { status: 408 });
		}
		if (!raw) return new Response("Unauthorized", { status: 401 });
		let interaction: DiscordInteraction;
		try {
			interaction = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(raw),
			);
		} catch {
			return new Response("Invalid JSON", { status: 400 });
		}
		if (!interaction || typeof interaction !== "object")
			return new Response("Invalid interaction", { status: 400 });
		if (interaction.type === 1) return Response.json({ type: 1 });
		if (
			typeof interaction.id !== "string" ||
			typeof interaction.token !== "string" ||
			!/^\d{1,20}$/.test(interaction.id ?? "") ||
			interaction.application_id !== env.CLIENT_ID ||
			!interaction.token ||
			interaction.token.length > 256
		)
			return new Response("Invalid interaction", { status: 400 });
		try {
			const immediate = await withinDeadline(
				immediateInteraction(interaction, env),
				Math.min(1200, Math.max(1, deadline - Date.now())),
			);
			if (immediate) return Response.json(immediate);
			const stub = env.GATEWAY.get(env.GATEWAY.idFromName("discord"));
			// A deferral acknowledges only a durably captured command, never waitUntil work.
			const queued = await withinDeadline(
				stub.fetch("https://gateway/commands", {
					method: "POST",
					body: JSON.stringify(interaction),
				}),
				Math.max(1, deadline - Date.now()),
			);
			if (!queued.ok) {
				await queued.body?.cancel();
				const status = [409, 410].includes(queued.status) ? queued.status : 503;
				return new Response(
					status === 409
						? "Interaction conflicts with captured command"
						: status === 410
							? "Interaction expired"
							: "Command queue unavailable",
					{ status },
				);
			}
			const captured = await captureResult(queued, deadline);
			if (captured.state === "completed")
				return Response.json({
					type: 4,
					data: {
						...captured.payload,
						flags: 64,
						allowed_mentions: { parse: [] },
					},
				});
			return Response.json({ type: 5, data: { flags: 64 } });
		} catch {
			if (interaction.type === 4)
				return Response.json({ type: 8, data: { choices: [] } });
			return new Response("Service unavailable", { status: 503 });
		}
	},
};
