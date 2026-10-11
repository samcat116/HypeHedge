import { Database } from "../database";
import { D1QueryBudget, D1QueryBudgetExceeded } from "./d1-budget";
import { type MessagePayload, executeInteraction } from "./interactions";

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
interface CommandRecord {
	time: number;
	payload: string;
	result?: MessagePayload;
	delivery?: "pending" | "delivered" | "expired" | "unavailable";
}
type CommandAdmission =
	| { state: "pending" }
	| { state: "completed"; payload: MessagePayload }
	| { state: "full" | "conflict" | "expired" };
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
	usersProcessed?: number;
	usersPage?: DiscordData[];
	userIndex?: number;
}
interface BackfillAdmission {
	guildId: string;
	limit?: number;
	reset?: boolean;
	interactionId?: string;
}
type BackfillAdmissionResult = "accepted" | "conflict" | "full";
const MAX_QUEUE = 512;
const MAX_COMMAND_RECORDS = 4096;
const JOB_LANES: Job["kind"][] = ["event", "command", "reply", "backfill"];
// Discord marks these close codes as non-reconnectable.
const TERMINAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const INTENTS = 1 | 512 | 1024; // GUILDS, GUILD_MESSAGES, GUILD_MESSAGE_REACTIONS

/** Workers fetch upgrades use HTTP(S), even when Discord returns a WSS URL. */
export function gatewayUpgradeUrl(raw: string, allowInsecure = false): URL {
	const url = new URL(raw);
	if (url.protocol === "wss:") url.protocol = "https:";
	else if (allowInsecure && url.protocol === "ws:") url.protocol = "http:";
	if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:"))
		throw new Error("Gateway requires a secure WebSocket URL");
	return url;
}

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
				const result = await this.admitCommand(interaction);
				if (
					result.state === "full" ||
					result.state === "conflict" ||
					result.state === "expired"
				)
					return Response.json(result, {
						status:
							result.state === "full"
								? 503
								: result.state === "conflict"
									? 409
									: 410,
					});
				if (result.state === "pending") await this.schedule();
				return Response.json(result);
			}
			if (path === "/backfill") {
				const data = (await request.json()) as DiscordData;
				if (!/^\d{1,20}$/.test(data.guildId ?? ""))
					return new Response("Invalid guild", { status: 400 });
				if (
					data.interactionId !== undefined &&
					!/^\d{1,20}$/.test(data.interactionId)
				)
					return new Response("Invalid interaction ID", { status: 400 });
				const result = await this.admitBackfill(data);
				if (result !== "accepted")
					return new Response(
						result === "conflict"
							? "Backfill admission conflicts with recorded interaction"
							: "Queue full",
						{ status: result === "conflict" ? 409 : 503 },
					);
				await this.schedule();
				return new Response("Backfill queued");
			}
			return new Response("Not found", { status: 404 });
		})();
	}
	/** Admission is short and independent from Discord REST calls in the effect lane. */
	private async admitBackfill(
		input: BackfillAdmission,
	): Promise<BackfillAdmissionResult> {
		const data = {
			guildId: input.guildId,
			limit: Math.min(1000, Math.max(1, Number(input.limit) || 100)),
			reset: input.reset === true,
		};
		const scanId = input.interactionId ?? crypto.randomUUID();
		const payload = JSON.stringify(data);
		return this.state.storage.transaction(async (tx) => {
			const receiptKey = `backfill-admission:${scanId}`;
			const previous = await tx.get<{ payload: string }>(receiptKey);
			if (previous)
				return previous.payload === payload ? "accepted" : "conflict";
			const key = `job:backfill:${data.guildId}`;
			const existing = await tx.get<Job>(key);
			const latest = await tx.get<string>(`backfill-latest:${data.guildId}`);
			// Interaction IDs are ordered snowflakes. Delayed old admissions cannot rewind a newer reset.
			const older =
				input.interactionId &&
				latest &&
				BigInt(input.interactionId) < BigInt(latest);
			if (!older && (!existing || data.reset)) {
				if (
					!existing &&
					(await tx.list({ prefix: "job:", limit: MAX_QUEUE })).size >=
						MAX_QUEUE
				)
					return "full";
				await tx.put(key, {
					kind: "backfill",
					id: `backfill:${data.guildId}`,
					data: {
						scanId,
						guildId: data.guildId,
						channelIndex: 0,
						limit: data.limit,
						scanned: 0,
					},
					attempts: 0,
					due: Date.now(),
				} satisfies Job);
			}
			await tx.put(receiptKey, {
				payload,
				scanId: older
					? undefined
					: existing && !data.reset
						? existing.data.scanId
						: scanId,
			});
			if (
				input.interactionId &&
				(!latest || BigInt(input.interactionId) > BigInt(latest))
			)
				await tx.put(`backfill-latest:${data.guildId}`, input.interactionId);
			return "accepted";
		});
	}
	private async currentGeneration(job: Job): Promise<boolean> {
		if (job.kind !== "backfill") return true;
		const current = await this.state.storage.get<Job>(`job:${job.id}`);
		return (
			current?.kind === "backfill" && current.data.scanId === job.data.scanId
		);
	}
	/** Every backfill completion/retry save is fenced against concurrently admitted resets. */
	private async saveJob(
		key: string,
		job: Job,
		complete: boolean,
		generation?: string,
	): Promise<void> {
		await this.state.storage.transaction(async (tx) => {
			if (generation !== undefined) {
				const current = await tx.get<Job>(key);
				if (current?.kind !== "backfill" || current.data.scanId !== generation)
					return;
			}
			if (job.kind === "reply") {
				const recordKey = `seen:${job.id}`;
				const record = await tx.get<CommandRecord>(recordKey);
				if (record)
					await tx.put(recordKey, {
						...record,
						result: job.data.payload,
						delivery: job.data.delivery ?? (complete ? "delivered" : "pending"),
					} satisfies CommandRecord);
			}
			if (complete) await tx.delete(key);
			else await tx.put(key, job);
		});
	}

	private async admitCommand(
		interaction: DiscordData,
	): Promise<CommandAdmission> {
		const id = `command:${interaction.id}`;
		const payload = JSON.stringify(interaction);
		return this.state.storage.transaction(async (tx) => {
			const key = `seen:${id}`;
			const record = await tx.get<CommandRecord>(key);
			if (record) {
				if (record.payload !== payload) return { state: "conflict" };
				if (record.result)
					return { state: "completed", payload: record.result };
				const existing = await tx.get<Job>(`job:${id}`);
				if (existing) return { state: "pending" };
				// A receipt without a job/result must never acknowledge work that cannot run.
				return {
					state: "completed",
					payload: {
						content:
							"This interaction has already been processed; its response is unavailable.",
						allowed_mentions: { parse: [] },
					},
				};
			}
			// An orphaned job has no authenticated original payload to compare; preserve it.
			if (await tx.get(`job:${id}`)) return { state: "conflict" };
			const createdAt = Number(BigInt(interaction.id) >> 22n) + 1420070400000;
			if (
				createdAt < Date.now() - 15 * 60 * 1000 ||
				createdAt > Date.now() + 300000
			)
				return { state: "expired" };
			if (
				(await tx.list({ prefix: "job:", limit: MAX_QUEUE })).size >= MAX_QUEUE
			)
				return { state: "full" };
			const recordCount = (await tx.get<number>("command-record-count")) ?? 0;
			if (recordCount >= MAX_COMMAND_RECORDS) return { state: "full" };
			await tx.put("command-record-count", recordCount + 1);
			await tx.put(`job:${id}`, {
				kind: "command",
				data: interaction,
				id,
				attempts: 0,
				due: Date.now(),
			} satisfies Job);
			await tx.put(key, { time: Date.now(), payload } satisfies CommandRecord);
			return { state: "pending" };
		});
	}
	private async schedule(delay = 1000) {
		const deadline = Date.now() + delay;
		// Intake and the effect lane can schedule concurrently. A later dispatch
		// must never postpone an already scheduled drain or reconnect.
		await this.state.storage.transaction(async (tx) => {
			const existing = await tx.getAlarm();
			if (existing === null || deadline < existing) await tx.setAlarm(deadline);
		});
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
			const invocationBudget = new D1QueryBudget();
			const invocationEnv = {
				...this.env,
				DB: invocationBudget.wrap(this.env.DB),
			};
			const lanes = new Map<Job["kind"], Array<[string, Job]>>(
				JOB_LANES.map((kind) => [
					kind,
					[...jobs].filter(([, job]) => job.kind === kind),
				]),
			);
			// Rotate each non-event lane across alarms so persistent backfills also make progress.
			for (const kind of JOB_LANES) {
				if (kind === "event") continue;
				const entries = lanes.get(kind) ?? [];
				const last = await this.state.storage.get<string>(
					`scheduler-last:${kind}`,
				);
				if (last) {
					const pivot = entries.findIndex(([key]) => key > last);
					if (pivot > 0)
						lanes.set(kind, [
							...entries.slice(pivot),
							...entries.slice(0, pivot),
						]);
				}
			}
			let lane = (await this.state.storage.get<number>("scheduler-lane")) ?? 0;
			const priority = await this.state.storage.get<{
				key: string;
				kind: Job["kind"];
				generation?: string;
			}>("scheduler-priority");
			let priorityKey: string | undefined;
			if (priority) {
				const entries = lanes.get(priority.kind) ?? [];
				const index = entries.findIndex(
					([key, job]) =>
						key === priority.key &&
						(priority.generation === undefined ||
							job.data.scanId === priority.generation),
				);
				if (index >= 0) {
					priorityKey = priority.key;
					lane = JOB_LANES.indexOf(priority.kind);
					if (priority.kind !== "event")
						lanes.set(priority.kind, [
							entries[index],
							...entries.filter((_, position) => position !== index),
						]);
				} else await this.state.storage.delete("scheduler-priority");
			}
			let processed = 0;
			// The event lane always takes its captured FIFO head; a delay/failure blocks its tail.
			let blockedEvents = false;
			while (processed < 16) {
				if (
					((await this.state.storage.get<number>("restPause")) ?? 0) >
					Date.now()
				)
					break;
				let selected: [string, Job] | undefined;
				for (let checked = 0; checked < JOB_LANES.length; checked++) {
					const kind = JOB_LANES[lane];
					lane = (lane + 1) % JOB_LANES.length;
					if (kind === "event" && blockedEvents) continue;
					const entries = lanes.get(kind) ?? [];
					if (kind === "event") {
						if (entries[0]?.[1].due > Date.now()) {
							blockedEvents = true;
							continue;
						}
						selected = entries.shift();
					} else {
						const ready = entries.findIndex(([, job]) => job.due <= Date.now());
						if (ready >= 0) selected = entries.splice(ready, 1)[0];
					}
					if (selected) break;
				}
				if (!selected) break;
				const [key, job] = selected;
				if (key === priorityKey) {
					await this.state.storage.delete("scheduler-priority");
					priorityKey = undefined;
				}
				if (!(await this.currentGeneration(job))) continue;
				const startUsed = invocationBudget.used;
				await this.state.storage.put({
					"scheduler-lane": lane,
					[`scheduler-last:${job.kind}`]: key,
				});
				const generation =
					job.kind === "backfill" ? (job.data.scanId as string) : undefined;
				processed++;
				try {
					const complete = await this.process(job, invocationEnv);
					await this.saveJob(key, job, complete, generation);
				} catch (error) {
					if (error instanceof D1QueryBudgetExceeded) {
						// A job denied a fresh budget retries the same key, not merely its lane.
						// A page that already started with a fresh budget yields its turn to other lanes.
						if (startUsed > 0 && !priorityKey)
							await this.state.storage.put({
								"scheduler-lane": JOB_LANES.indexOf(job.kind),
								"scheduler-priority": { key, kind: job.kind, generation },
							});
						job.due = Date.now() + 1000;
						await this.saveJob(key, job, false, generation);
						break;
					}
					if (error instanceof BackfillLimit) {
						await this.failure(error.message);
						await this.saveJob(key, job, true, generation);
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
						if (job.kind === "reply") job.data.delivery = "unavailable";
						await this.failure(
							`${job.kind}: inaccessible Discord resource (${error.status})`,
						);
						await this.saveJob(key, job, true, generation);
						continue;
					}
					await this.saveJob(key, job, false, generation);
					if (job.kind === "event") blockedEvents = true;
				}
			}
			// Interaction replay records expire after Discord tokens are no longer usable.
			const cleanupCursor = await this.state.storage.get<string>(
				"command-cleanup-cursor",
			);
			const seen = await this.state.storage.list<CommandRecord>({
				prefix: "seen:",
				limit: 128,
				startAfter: cleanupCursor,
			});
			await this.state.storage.transaction(async (tx) => {
				let removed = 0;
				for (const [key, record] of seen) {
					if (
						record.time < Date.now() - 86400000 &&
						!(await tx.get(`job:${key.slice(5)}`))
					) {
						await tx.delete(key);
						removed++;
					}
				}
				if (removed)
					await tx.put(
						"command-record-count",
						Math.max(
							0,
							((await tx.get<number>("command-record-count")) ?? 0) - removed,
						),
					);
				const last = [...seen.keys()].at(-1);
				if (last) await tx.put("command-cleanup-cursor", last);
				else await tx.delete("command-cleanup-cursor");
			});
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
			else if (seen.size || cleanupCursor) await this.schedule(3600000);
		});
	}
	private async connect() {
		this.connecting = true;
		try {
			const url =
				this.session.id && this.session.url
					? this.session.url
					: (this.env.GATEWAY_URL ?? (await this.api("/gateway/bot")).url);
			const parsed = gatewayUpgradeUrl(url, Boolean(this.env.GATEWAY_URL));
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
					const code = "code" in event ? event.code : 0;
					this.disconnect(!TERMINAL_CLOSE_CODES.has(code));
					this.state.waitUntil(
						this.capture(async () => {
							if (TERMINAL_CLOSE_CODES.has(code)) {
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
	private disconnect(resumable = true) {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
		const socket = this.socket;
		this.socket = undefined;
		try {
			// Discord invalidates sessions closed with 1000/1001. Recovery must preserve replay.
			socket?.close(
				resumable ? 4000 : 1000,
				resumable ? "Reconnect" : "Stopped",
			);
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
				if (
					frame.t === "MESSAGE_REACTION_ADD" ||
					frame.t === "MESSAGE_REACTION_REMOVE"
				) {
					if (pending.size >= MAX_QUEUE) return false;
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
			if (
				frame.t === "MESSAGE_REACTION_ADD" ||
				frame.t === "MESSAGE_REACTION_REMOVE"
			)
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
	private async process(
		job: Job,
		env: GatewayEnv = this.env,
	): Promise<boolean> {
		const db = new Database(env.DB);
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
			let data: MessagePayload;
			try {
				data = await executeInteraction(job.data, env, async (input) => {
					const result = await this.admitBackfill({
						...input,
						interactionId: job.data.id,
					});
					if (result !== "accepted")
						throw new BackfillAdmissionUnavailable(result);
					return true;
				});
			} catch (error) {
				if (!(error instanceof BackfillAdmissionUnavailable)) throw error;
				data = { content: error.message, allowed_mentions: { parse: [] } };
			}
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
				job.data.delivery = "expired";
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
	private advanceChannel(data: Backfill) {
		data.channelIndex++;
		data.scanned = 0;
		data.before = undefined;
		data.message = undefined;
		data.reactionIndex = undefined;
		data.userAfter = undefined;
		data.userPages = undefined;
		data.usersProcessed = undefined;
		data.usersPage = undefined;
		data.userIndex = undefined;
	}
	private finishMessage(data: Backfill) {
		data.scanned++;
		data.before = data.message?.id;
		data.message = undefined;
		data.reactionIndex = undefined;
		data.userAfter = undefined;
		data.userPages = undefined;
		data.usersProcessed = undefined;
		data.usersPage = undefined;
		data.userIndex = undefined;
		if (data.scanned >= data.limit) this.advanceChannel(data);
	}

	private async backfill(job: Job, db: Database): Promise<boolean> {
		const data = job.data as Backfill;
		let stage = "guild channel enumeration";
		try {
			if (!data.channelIds) {
				stage = "guild channel enumeration";
				const channels = (
					await this.api(`/guilds/${data.guildId}/channels`)
				).filter((c: DiscordData) => c.type === 0 || c.type === 5);
				if (channels.length > 500)
					throw new BackfillLimit(
						"Backfill refused: guild exceeds 500-channel limit",
					);
				if (!(await this.currentGeneration(job))) return true;
				data.channelIds = channels.map((c: DiscordData) => c.id);
			}
			const channel = data.channelIds?.[data.channelIndex];
			if (!channel) return true;
			if (!data.message) {
				stage = "channel message listing";
				const messages = await this.api(
					`/channels/${channel}/messages?limit=1${data.before ? `&before=${data.before}` : ""}`,
				);
				if (!(await this.currentGeneration(job))) return true;
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
				stage = "message reaction enumeration";
				if (!data.usersPage) {
					data.usersPage = await this.api(
						`/channels/${channel}/messages/${message.id}/reactions/${encodeURIComponent(pathEmoji)}?limit=100${data.userAfter ? `&after=${data.userAfter}` : ""}`,
					);
					data.userIndex = 0;
				}
				const users = data.usersPage;
				if (!Array.isArray(users))
					throw new Error("Invalid Discord reaction user page");
				if (!(await this.currentGeneration(job))) return true;
				for (let index = data.userIndex ?? 0; index < users.length; index++) {
					if ((data.usersProcessed ?? 0) >= 10000)
						throw new BackfillLimit(
							"Backfill partial: reaction exceeds 10000-user limit",
						);
					if (!(await this.currentGeneration(job))) return true;
					const user = users[index];
					if (!user.bot && user.id !== message.author.id)
						await db.addReaction(
							message.id,
							user.id,
							message.author.id,
							emoji,
							`backfill:${data.scanId}:${message.id}:${user.id}:${emoji}`,
						);
					// Advance only after the idempotent award resolves. Persist this captured page on budget yield.
					data.userIndex = index + 1;
					data.userAfter = user.id;
					data.usersProcessed = (data.usersProcessed ?? 0) + 1;
				}
				data.usersPage = undefined;
				data.userIndex = undefined;
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
					data.usersProcessed = 0;
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
		} catch (error) {
			if (
				!(error instanceof RestError) ||
				(error.status !== 403 && error.status !== 404)
			)
				throw error;
			if (!(await this.currentGeneration(job))) return true;
			await this.failure(
				`Backfill partial: scan ${data.scanId}, guild ${data.guildId}, ${stage}, channel ${data.channelIds?.[data.channelIndex] ?? "none"}, message ${data.message?.id ?? "none"}: Discord ${error.status}`,
			);
			if (stage === "guild channel enumeration") return true;
			if (stage === "channel message listing" || error.status === 403)
				this.advanceChannel(data);
			else this.finishMessage(data);
			job.due = Date.now() + 1000;
			return !data.channelIds?.[data.channelIndex];
		}
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

class BackfillAdmissionUnavailable extends Error {
	constructor(result: "conflict" | "full") {
		super(
			result === "full"
				? "Backfill queue is full. Retry after pending commands complete."
				: "Backfill request conflicts with the recorded interaction; this replay did not change the scan.",
		);
	}
}
