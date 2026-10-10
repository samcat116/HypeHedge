import { Database } from "../database";
import { executeInteraction } from "./interactions";

// biome-ignore lint/suspicious/noExplicitAny: Discord Gateway wire JSON is validated per event at the boundary.
type DiscordData = any;

export interface GatewayEnv {
	DB: D1Database;
	BOT_TOKEN: string;
	CLIENT_ID: string;
	GATEWAY: DurableObjectNamespace;
	DISCORD_PUBLIC_KEY: string;
	DISCORD_API_BASE?: string;
	GATEWAY_URL?: string;
}
interface Session {
	id?: string;
	url?: string;
	seq: number | null;
}
interface Frame {
	op: number;
	s?: number;
	t?: string;
	d: DiscordData;
}
interface Job {
	kind: "event" | "command" | "reply" | "backfill";
	data: DiscordData;
	id: string;
	attempts: number;
	due: number;
}
interface Backfill {
	scanId: string;
	guildId: string;
	channelIds?: string[];
	channelIndex: number;
	limit: number;
	scanned: number;
	before?: string;
	message?: DiscordData;
	reactionIndex?: number;
	userAfter?: string;
	userPages?: number;
}
const MAX_QUEUE = 512;
const INTENTS = 1 | 512 | 1024; // GUILDS, GUILD_MESSAGES, GUILD_MESSAGE_REACTIONS

/** Only reachable through a binding: the Worker never forwards public paths here. */
export class GatewayDO {
	private socket?: WebSocket;
	private heartbeat?: ReturnType<typeof setInterval>;
	private acknowledged = true;
	private connecting = false;
	private serial: Promise<unknown> = Promise.resolve();
	private intake: Promise<unknown> = Promise.resolve();
	private session: Session = { seq: null };
	constructor(
		private state: DurableObjectState,
		private env: GatewayEnv,
	) {
		state.blockConcurrencyWhile(async () => {
			this.session = (await state.storage.get<Session>("session")) ?? {
				seq: null,
			};
		});
	}
	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.serial.then(fn);
		this.serial = result.catch(() => {});
		return result;
	}
	private capture<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.intake.then(fn);
		this.intake = result.catch(() => {});
		return result;
	}

	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (request.method === "GET" && path === "/status") {
			return Response.json({
				connected: this.socket?.readyState === 1,
				queued: (await this.state.storage.list({ prefix: "job:" })).size,
				sequence: this.session.seq,
				failures: (await this.state.storage.get("failures")) ?? 0,
				lastFailure: await this.state.storage.get("lastFailure"),
			});
		}
		if (request.method !== "POST")
			return new Response("Not found", { status: 404 });
		return (async () => {
			if (path === "/recover") {
				if (
					(await this.state.storage.get("enabled")) ||
					(await this.state.storage.list({ prefix: "job:", limit: 1 })).size
				)
					await this.schedule();
				return new Response("Recovered");
			}
			if (path === "/start") {
				await this.state.storage.put("enabled", true);
				await this.schedule();
				return new Response("Started");
			}
			if (path === "/commands") {
				const interaction = (await request.json()) as DiscordData;
				if (
					!/^\d{1,20}$/.test(interaction.id ?? "") ||
					typeof interaction.token !== "string"
				)
					return new Response("Invalid interaction", { status: 400 });
				const id = `command:${interaction.id}`;
				if (
					!(await this.enqueue(
						{
							kind: "command",
							data: interaction,
							id,
							attempts: 0,
							due: Date.now(),
						},
						true,
					))
				)
					return new Response("Queue full", { status: 503 });
				await this.schedule();
				return new Response("Captured");
			}
			if (path === "/backfill") {
				const data = (await request.json()) as DiscordData;
				if (!/^\d{1,20}$/.test(data.guildId ?? ""))
					return new Response("Invalid guild", { status: 400 });
				const job: Backfill = {
					scanId: crypto.randomUUID(),
					guildId: data.guildId,
					channelIndex: 0,
					limit: Math.min(1000, Math.max(1, Number(data.limit) || 100)),
					scanned: 0,
				};
				const id = `backfill:${data.guildId}`;
				if (await this.state.storage.get(`job:${id}`))
					return new Response("Already running");
				if (
					!(await this.enqueue({
						kind: "backfill",
						data: job,
						id,
						attempts: 0,
						due: Date.now(),
					}))
				)
					return new Response("Queue full", { status: 503 });
				await this.schedule();
				return new Response("Backfill queued");
			}
			return new Response("Not found", { status: 404 });
		})();
	}
	private async enqueue(job: Job, remember = false): Promise<boolean> {
		return this.state.storage.transaction(async (tx) => {
			if (remember) {
				const seen = await tx.get<{ time: number; payload: string }>(
					`seen:${job.id}`,
				);
				if (seen) return seen.payload === JSON.stringify(job.data);
			}
			if (
				(await tx.list({ prefix: "job:", limit: MAX_QUEUE })).size >= MAX_QUEUE
			)
				return false;
			await tx.put(`job:${job.id}`, job);
			if (remember)
				await tx.put(`seen:${job.id}`, {
					time: Date.now(),
					payload: JSON.stringify(job.data),
				});
			return true;
		});
	}
	private async schedule(delay = 1000) {
		await this.state.storage.setAlarm(Date.now() + delay);
	}
	async alarm(): Promise<void> {
		await this.exclusive(async () => {
			if (
				(await this.state.storage.get("enabled")) &&
				!this.socket &&
				!this.connecting
			)
				await this.connect();
			const jobs = await this.state.storage.list<Job>({
				prefix: "job:",
				limit: MAX_QUEUE,
			});
			let processed = 0;
			// Event IDs contain zero-padded sequence numbers. Never overtake a failed event.
			let blockedEvents = false;
			for (const [key, job] of jobs) {
				if (processed >= 16) break;
				if (job.kind === "event" && blockedEvents) continue;
				if (
					job.due > Date.now() ||
					((await this.state.storage.get<number>("restPause")) ?? 0) >
						Date.now()
				) {
					if (job.kind === "event") blockedEvents = true;
					continue;
				}
				processed++;
				try {
					const complete = await this.process(job);
					if (complete) await this.state.storage.delete(key);
					else await this.state.storage.put(key, job);
				} catch (error) {
					if (error instanceof BackfillLimit) {
						await this.failure(error.message);
						await this.state.storage.delete(key);
						continue;
					}
					job.attempts++;
					job.due =
						Date.now() + Math.min(60000, 1000 * 2 ** Math.min(6, job.attempts));
					if (error instanceof RateLimited) {
						job.due = Date.now() + error.delay;
						await this.state.storage.put("restPause", job.due);
					}
					if (
						error instanceof RestError &&
						(error.status === 403 || error.status === 404) &&
						(job.kind === "event" || job.kind === "reply")
					) {
						await this.failure(
							`${job.kind}: inaccessible Discord resource (${error.status})`,
						);
						await this.state.storage.delete(key);
						continue;
					}
					await this.state.storage.put(key, job);
					if (job.kind === "event") blockedEvents = true;
				}
			}
			// Interaction replay records expire after Discord tokens are no longer usable.
			const seen = await this.state.storage.list<{
				time: number;
				payload: string;
			}>({ prefix: "seen:", limit: 128 });
			for (const [key, time] of seen)
				if (time.time < Date.now() - 86400000)
					await this.state.storage.delete(key);
			const pending = await this.state.storage.list<Job>({
				prefix: "job:",
				limit: MAX_QUEUE,
			});
			if (pending.size) {
				let firstEvent = false;
				const times: number[] = [];
				for (const queued of pending.values()) {
					if (queued.kind === "event") {
						if (firstEvent) continue;
						firstEvent = true;
					}
					times.push(queued.due);
				}
				const due = Math.max(
					Math.min(...times),
					(await this.state.storage.get<number>("restPause")) ?? 0,
				);
				await this.schedule(Math.max(1000, due - Date.now()));
			} else if (await this.state.storage.get("enabled"))
				await this.schedule(60000);
		});
	}
	private async connect() {
		this.connecting = true;
		try {
			const url =
				this.session.id && this.session.url
					? this.session.url
					: (this.env.GATEWAY_URL ?? (await this.api("/gateway/bot")).url);
			const parsed = new URL(url);
			parsed.searchParams.set("v", "10");
			parsed.searchParams.set("encoding", "json");
			const response = await fetch(parsed, {
				headers: { Upgrade: "websocket" },
			});
			const socket = response.webSocket;
			if (!socket) throw new Error("Gateway did not upgrade");
			socket.accept();
			this.socket = socket;
			socket.addEventListener("message", (event) => {
				this.state.waitUntil(
					this.capture(async () => {
						if (this.socket !== socket) return;
						try {
							await this.frame(JSON.parse(String(event.data)) as Frame);
						} catch {
							this.disconnect();
							await this.schedule(5000);
						}
					}),
				);
			});
			const closed = (event: CloseEvent | Event) => {
				if (this.socket === socket) {
					this.disconnect();
					this.state.waitUntil(
						this.capture(async () => {
							const code = "code" in event ? event.code : 0;
							if (code === 4004 || code === 4014) {
								await this.state.storage.put("enabled", false);
								await this.failure(`Fatal Gateway close ${code}`);
							} else {
								if (code === 4007 || code === 4009) {
									this.session = { seq: null };
									await this.state.storage.put("session", this.session);
								}
								await this.schedule(5000);
							}
						}),
					);
				}
			};
			socket.addEventListener("close", closed);
			socket.addEventListener("error", closed);
		} catch {
			await this.schedule(5000);
		} finally {
			this.connecting = false;
		}
	}
	private send(frame: unknown) {
		this.socket?.send(JSON.stringify(frame));
	}
	private disconnect() {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
		const socket = this.socket;
		this.socket = undefined;
		try {
			socket?.close(1000, "Reconnect");
		} catch {}
	}
	private beat() {
		if (!this.acknowledged) {
			this.disconnect();
			this.state.waitUntil(this.schedule(5000));
			return;
		}
		this.acknowledged = false;
		this.send({ op: 1, d: this.session.seq });
	}
	private async frame(frame: Frame) {
		if (frame.op === 10) {
			const interval = Number(frame.d.heartbeat_interval);
			if (!Number.isFinite(interval) || interval < 100 || interval > 300000)
				throw new Error("Invalid heartbeat");
			if (this.heartbeat) clearInterval(this.heartbeat);
			this.acknowledged = true;
			this.heartbeat = setInterval(() => this.beat(), interval);
			this.send(
				this.session.id
					? {
							op: 6,
							d: {
								token: this.env.BOT_TOKEN,
								session_id: this.session.id,
								seq: this.session.seq,
							},
						}
					: {
							op: 2,
							d: {
								token: this.env.BOT_TOKEN,
								intents: INTENTS,
								properties: {
									os: "cloudflare",
									browser: "hypehedge",
									device: "hypehedge",
								},
							},
						},
			);
		} else if (frame.op === 11) this.acknowledged = true;
		else if (frame.op === 1) {
			this.acknowledged = true;
			this.beat();
		} else if (frame.op === 7) {
			this.disconnect();
			await this.schedule(1000);
		} else if (frame.op === 9) {
			if (!frame.d) {
				this.session = { seq: null };
				await this.state.storage.put("session", this.session);
			}
			this.disconnect();
			await this.schedule(5000);
		} else if (frame.op === 0 && Number.isSafeInteger(frame.s)) {
			if (this.session.seq !== null && (frame.s ?? 0) <= this.session.seq)
				return;
			const next: Session =
				frame.t === "READY"
					? {
							seq: frame.s ?? 0,
							id: frame.d.session_id,
							url: frame.d.resume_gateway_url,
						}
					: { ...this.session, seq: frame.s ?? 0 };
			const captured = await this.state.storage.transaction(async (tx) => {
				const pending = await tx.list({ prefix: "job:", limit: MAX_QUEUE });
				if (pending.size >= MAX_QUEUE) return false;
				if (
					frame.t === "MESSAGE_REACTION_ADD" ||
					frame.t === "MESSAGE_REACTION_REMOVE"
				) {
					const ordinal = ((await tx.get<number>("captureCounter")) ?? 0) + 1;
					await tx.put("captureCounter", ordinal);
					const id = `event:${String(ordinal).padStart(16, "0")}:${next.id}:${frame.s}`;
					await tx.put(`job:${id}`, {
						kind: "event",
						data: frame,
						id,
						attempts: 0,
						due: Date.now(),
					} satisfies Job);
				}
				await tx.put("session", next);
				return true;
			});
			if (!captured) {
				this.disconnect();
				await this.schedule(5000);
				return;
			}
			this.session = next;
			await this.schedule();
		}
	}
	private async failure(reason: string) {
		await this.state.storage.put({
			failures: ((await this.state.storage.get<number>("failures")) ?? 0) + 1,
			lastFailure: { reason, time: Date.now() },
		});
	}
	private async api(
		path: string,
		init: RequestInit = {},
	): Promise<DiscordData> {
		const response = await fetch(
			`${this.env.DISCORD_API_BASE ?? "https://discord.com/api/v10"}${path}`,
			{
				...init,
				headers: {
					Authorization: `Bot ${this.env.BOT_TOKEN}`,
					"Content-Type": "application/json",
					...init.headers,
				},
			},
		);
		if (response.status === 429) {
			const body = (await response.json()) as DiscordData;
			throw new RateLimited(
				Math.max(
					1000,
					Math.min(3600000, Number(body.retry_after) * 1000 || 1000),
				),
			);
		}
		if (!response.ok) throw new RestError(response.status);
		return response.status === 204 ? null : response.json();
	}
	private async process(job: Job): Promise<boolean> {
		const db = new Database(this.env.DB);
		if (job.kind === "event") {
			const frame = job.data as Frame;
			const d = frame.d;
			const emoji = d.emoji.id ?? d.emoji.name;
			if (!emoji || !d.guild_id) return true;
			if (frame.t === "MESSAGE_REACTION_REMOVE")
				await db.removeReaction(d.message_id, d.user_id, emoji, job.id);
			else {
				const message = await this.api(
					`/channels/${d.channel_id}/messages/${d.message_id}`,
				);
				const reactor =
					d.member?.user ?? (await this.api(`/users/${d.user_id}`));
				if (
					!message.author.bot &&
					!reactor.bot &&
					message.author.id !== d.user_id
				)
					await db.addReaction(
						d.message_id,
						d.user_id,
						message.author.id,
						emoji,
						job.id,
					);
			}
			return true;
		}
		if (job.kind === "command") {
			const data = await executeInteraction(
				job.data,
				this.env,
				async (data) => {
					const id = `backfill:${data.guildId}`;
					if (await this.state.storage.get(`job:${id}`)) return true;
					return this.enqueue({
						kind: "backfill",
						data: {
							guildId: data.guildId,
							scanId: job.data.id,
							channelIndex: 0,
							limit: Math.min(1000, Math.max(1, data.limit)),
							scanned: 0,
						},
						id,
						attempts: 0,
						due: Date.now(),
					});
				},
			);
			// Same job becomes its outbox atomically; crash before this write reruns the receipt-backed command.
			job.kind = "reply";
			job.data = {
				applicationId: job.data.application_id,
				token: job.data.token,
				payload: data,
				expiresAt:
					Number(BigInt(job.data.id) >> 22n) + 1420070400000 + 14 * 60 * 1000,
			};
			return false;
		}
		if (job.kind === "reply") {
			if (job.data.expiresAt < Date.now()) {
				await this.failure(
					"Reply token expired after durable command execution",
				);
				return true;
			}
			await this.api(
				`/webhooks/${job.data.applicationId}/${job.data.token}/messages/@original`,
				{ method: "PATCH", body: JSON.stringify(job.data.payload) },
			);
			return true;
		}
		return this.backfill(job, db);
	}
	private async backfill(job: Job, db: Database): Promise<boolean> {
		const data = job.data as Backfill;
		if (!data.channelIds) {
			const channels = (
				await this.api(`/guilds/${data.guildId}/channels`)
			).filter((c: DiscordData) => c.type === 0 || c.type === 5);
			if (channels.length > 500)
				throw new BackfillLimit(
					"Backfill refused: guild exceeds 500-channel limit",
				);
			data.channelIds = channels.map((c: DiscordData) => c.id);
		}
		const channel = data.channelIds?.[data.channelIndex];
		if (!channel) return true;
		if (!data.message) {
			const messages = await this.api(
				`/channels/${channel}/messages?limit=1${data.before ? `&before=${data.before}` : ""}`,
			);
			if (!messages.length) {
				data.channelIndex++;
				data.scanned = 0;
				data.before = undefined;
				return !data.channelIds?.[data.channelIndex];
			}
			data.message = messages[0];
			data.reactionIndex = 0;
			data.userPages = 0;
		}
		const message = data.message;
		const reaction = message.author.bot
			? undefined
			: message.reactions?.[data.reactionIndex ?? 0];
		if (reaction) {
			if ((data.userPages ?? 0) >= 100)
				throw new BackfillLimit(
					"Backfill partial: reaction exceeds 10000-user limit",
				);
			const emoji = reaction.emoji.id ?? reaction.emoji.name;
			const pathEmoji = reaction.emoji.id
				? `${reaction.emoji.name}:${reaction.emoji.id}`
				: emoji;
			const users = await this.api(
				`/channels/${channel}/messages/${message.id}/reactions/${encodeURIComponent(pathEmoji)}?limit=100${data.userAfter ? `&after=${data.userAfter}` : ""}`,
			);
			for (const user of users)
				if (!user.bot && user.id !== message.author.id)
					await db.addReaction(
						message.id,
						user.id,
						message.author.id,
						emoji,
						`backfill:${data.scanId}:${message.id}:${user.id}:${emoji}`,
					);
			data.userPages = (data.userPages ?? 0) + 1;
			if (users.length === 100) {
				data.userAfter = users.at(-1).id;
				// Refuse unbounded scans rather than silently marking partial awards complete.
				if (data.userPages >= 100)
					throw new BackfillLimit(
						"Backfill partial: reaction exceeds 10000-user limit",
					);
			} else {
				data.reactionIndex = (data.reactionIndex ?? 0) + 1;
				data.userAfter = undefined;
				data.userPages = 0;
			}
		} else {
			data.scanned++;
			data.before = message.id;
			data.message = undefined;
			data.reactionIndex = undefined;
			if (data.scanned >= data.limit) {
				data.channelIndex++;
				data.scanned = 0;
				data.before = undefined;
			}
		}
		job.due = Date.now() + 1000;
		return !data.channelIds?.[data.channelIndex];
	}
}
class RateLimited extends Error {
	constructor(readonly delay: number) {
		super("Discord rate limited");
	}
}

class RestError extends Error {
	constructor(readonly status: number) {
		super(`Discord REST ${status}`);
	}
}

class BackfillLimit extends Error {}
