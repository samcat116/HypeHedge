import {
	formatPriceUnits,
	formatShareUnits,
	formatUnits,
	parsePriceToUnits,
} from "../accounting";
import { Database } from "../database";

export interface InteractionEnv {
	DB: D1Database;
	BOT_TOKEN: string;
	CLIENT_ID: string;
	DISCORD_PUBLIC_KEY: string;
	GATEWAY: DurableObjectNamespace;
}
export interface DiscordOption {
	name: string;
	type: number;
	value?: string | number | boolean;
	focused?: boolean;
	options?: DiscordOption[];
}
export interface DiscordComponent {
	type: number;
	custom_id?: string;
	value?: string;
	values?: string[];
	components?: DiscordComponent[];
	component?: DiscordComponent;
}
export interface DiscordInteraction {
	id: string;
	application_id: string;
	token: string;
	type: number;
	guild_id?: string;
	member?: { user: { id: string }; permissions?: string };
	user?: { id: string };
	data?: {
		name?: string;
		options?: DiscordOption[];
		custom_id?: string;
		values?: string[];
		components?: DiscordComponent[];
	};
}
export type MessagePayload = {
	content?: string;
	embeds?: unknown[];
	components?: unknown[];
	allowed_mentions?: { parse: string[] };
	flags?: number;
};
export type InteractionResponse = {
	type: number;
	data?: Record<string, unknown>;
};
export type EnqueueBackfill = (data: {
	guildId: string;
	limit: number;
	reset?: boolean;
}) => Promise<boolean>;
class InteractionInputError extends Error {}
function validateInputs(i: DiscordInteraction): void {
	const invalid = () => {
		throw new InteractionInputError("Invalid interaction controls.");
	};
	if (i.data?.name !== undefined && typeof i.data.name !== "string") invalid();
	if (
		i.data?.custom_id !== undefined &&
		(typeof i.data.custom_id !== "string" || i.data.custom_id.length > 100)
	)
		invalid();
	let count = 0;
	const validateOptions = (
		items: DiscordOption[] | undefined,
		depth = 0,
	): void => {
		if (items === undefined) return;
		if (!Array.isArray(items) || depth > 3) invalid();
		for (const o of items) {
			if (
				!o ||
				typeof o.name !== "string" ||
				!Number.isInteger(o.type) ||
				++count > 100
			)
				invalid();
			validateOptions(o.options, depth + 1);
		}
	};
	validateOptions(i.data?.options);
	const validateComponents = (
		items: DiscordComponent[] | undefined,
		depth = 0,
	): void => {
		if (items === undefined) return;
		if (!Array.isArray(items) || depth > 4) invalid();
		for (const c of items) {
			if (!c || !Number.isInteger(c.type) || ++count > 150) invalid();
			if (c.custom_id !== undefined && typeof c.custom_id !== "string")
				invalid();
			if (c.value !== undefined && typeof c.value !== "string") invalid();
			if (
				c.values !== undefined &&
				(!Array.isArray(c.values) ||
					c.values.some((v) => typeof v !== "string"))
			)
				invalid();
			validateComponents(c.components, depth + 1);
			if (c.component) validateComponents([c.component], depth + 1);
		}
	};
	validateComponents(i.data?.components);
	if (
		i.data?.values !== undefined &&
		(!Array.isArray(i.data.values) ||
			i.data.values.some((v) => typeof v !== "string"))
	)
		invalid();
}
function isAdmin(i: DiscordInteraction): boolean {
	try {
		return (BigInt(i.member?.permissions ?? "0") & 8n) !== 0n;
	} catch {
		return false;
	}
}
const message = (content: string): MessagePayload => ({
	content: content.slice(0, 1900),
	allowed_mentions: { parse: [] },
});
const reply = (content: string): InteractionResponse => ({
	type: 4,
	data: { ...message(content), flags: 64 },
});
const userId = (i: DiscordInteraction) =>
	i.member?.user?.id ?? i.user?.id ?? "";
function options(i: DiscordInteraction): DiscordOption[] {
	const walk = (items: DiscordOption[]): DiscordOption[] =>
		items.flatMap((item) => [item, ...walk(item.options ?? [])]);
	return walk(i.data?.options ?? []);
}
const option = (i: DiscordInteraction, name: string) =>
	options(i).find((o) => o.name === name)?.value;
const subcommand = (i: DiscordInteraction) =>
	options(i).find((o) => o.type === 1)?.name;
function fields(i: DiscordInteraction): Record<string, string> {
	const result: Record<string, string> = {};
	const walk = (cs: DiscordComponent[]) => {
		for (const c of cs) {
			if (c.custom_id) result[c.custom_id] = c.value ?? c.values?.[0] ?? "";
			walk(c.components ?? []);
			if (c.component) walk([c.component]);
		}
	};
	walk(i.data?.components ?? []);
	return result;
}
const row = (components: unknown[]) => ({ type: 1, components });
const button = (custom_id: string, label: string, disabled = false) => ({
	type: 2,
	style: 2,
	custom_id,
	label,
	disabled,
});
function pagination(
	prefix: string,
	page: number,
	hasMore: boolean,
	suffix = "",
) {
	return [
		row([
			button(`${prefix}:prev:${page}${suffix}`, "Previous", page === 0),
			button(`${prefix}:next:${page}${suffix}`, "Next", !hasMore),
		]),
	];
}
function page(i: DiscordInteraction): number {
	const [, direction, raw] = (i.data?.custom_id ?? "").split(":");
	if (!/^\d{1,5}$/.test(raw ?? "") || !["next", "prev"].includes(direction))
		throw new InteractionInputError("Invalid page.");
	return Math.max(
		0,
		Math.min(10000, Number(raw) + (direction === "next" ? 1 : -1)),
	);
}
function modal(
	custom_id: string,
	title: string,
	inputs: { id: string; label: string; max: number; style?: number }[],
): InteractionResponse {
	return {
		type: 9,
		data: {
			custom_id,
			title: title.slice(0, 45),
			components: inputs.map((input) =>
				row([
					{
						type: 4,
						custom_id: input.id,
						label: input.label,
						style: input.style ?? 1,
						required: true,
						max_length: input.max,
					},
				]),
			),
		},
	};
}
async function scopedMarket(db: Database, i: DiscordInteraction, id: string) {
	const market = await db.getMarket(id);
	if (!market || market.guildId !== i.guild_id)
		throw new InteractionInputError("Market not found in this server.");
	return market;
}
/** Only operations that must respond immediately (ping, autocomplete, opening modals). */
export async function immediateInteraction(
	i: DiscordInteraction,
	env: InteractionEnv,
): Promise<InteractionResponse | null> {
	try {
		validateInputs(i);
	} catch (error) {
		return reply((error as Error).message);
	}
	if (![2, 3, 4, 5].includes(i.type)) return reply("Unsupported interaction.");
	if (!/^\d{1,20}$/.test(userId(i))) return reply("Missing user.");
	if (!i.guild_id)
		return i.type === 4
			? { type: 8, data: { choices: [] } }
			: reply("Use this command in a server.");
	if (i.data?.name === "backfill") {
		try {
			if (!isAdmin(i)) return reply("Administrator permission is required.");
		} catch {
			return reply("Administrator permission is required.");
		}
	}
	const db = new Database(env.DB);
	if (i.type === 4) {
		try {
			const focused = options(i).find((o) => o.focused);
			const query = String(focused?.value ?? "").toLowerCase();
			if (focused?.name === "outcome") {
				const market = await scopedMarket(
					db,
					i,
					String(option(i, "market") ?? ""),
				);
				return {
					type: 8,
					data: {
						choices: market.outcomes
							.filter((o) => o.description.toLowerCase().includes(query))
							.slice(0, 25)
							.map((o) => ({ name: o.description.slice(0, 100), value: o.id })),
					},
				};
			}
			// One bounded read avoids fetching every market's outcome rows before the HTTP deadline.
			const mode = subcommand(i);
			const result = await env.DB.prepare(
				`SELECT m.id,m.number,m.description FROM markets m WHERE m.guild_id=? AND m.status='open' AND instr(lower(m.description),?)>0 AND (?!='resolve' OR m.oracle_user_id=?) AND (?!='cancel' OR EXISTS(SELECT 1 FROM orders o WHERE o.market_id=m.id AND o.user_id=?)) ORDER BY m.number DESC LIMIT 25`,
			)
				.bind(i.guild_id, query, mode ?? "", userId(i), mode ?? "", userId(i))
				.all<{ id: string; number: number; description: string }>();
			return {
				type: 8,
				data: {
					choices: result.results.map((m) => ({
						name: `#${m.number} ${m.description}`.slice(0, 100),
						value: m.id,
					})),
				},
			};
		} catch {
			return { type: 8, data: { choices: [] } };
		}
	}
	if (
		i.type === 2 &&
		i.data?.name === "market" &&
		options(i).some((o) => o.type === 2 && o.name === "create")
	) {
		const multi = subcommand(i) === "multi";
		const response = modal(
			`market:create:${multi ? "multi" : "binary"}`,
			"Create Market",
			[
				{ id: "description", label: "Prediction", max: 500, style: 2 },
				...(multi
					? [
							{
								id: "options",
								label: "Comma-separated choices (2-10)",
								max: 500,
							},
						]
					: []),
			],
		);
		(response.data?.components as unknown[]).push({
			type: 18,
			label: "Oracle (defaults to you)",
			component: {
				type: 5,
				custom_id: "oracle",
				required: false,
				min_values: 0,
				max_values: 1,
			},
		});
		return response;
	}
	if (
		i.type === 3 &&
		/^market:quickorder:[^:]+:[^:]+$/.test(i.data?.custom_id ?? "")
	) {
		const [, , marketId, outcomeId] = (i.data?.custom_id ?? "").split(":");
		try {
			const market = await scopedMarket(db, i, marketId);
			if (
				market.status !== "open" ||
				!market.outcomes.some((o) => o.id === outcomeId)
			)
				return reply("Outcome unavailable.");
			return modal(
				`market:quickorder:confirm:${marketId}:${outcomeId}`,
				"Place order",
				[
					{ id: "direction", label: "Direction (buy or sell)", max: 4 },
					{ id: "quantity", label: "Quantity (1-1000)", max: 4 },
					{ id: "price", label: "Price (0.01-0.99)", max: 4 },
				],
			);
		} catch (error) {
			return reply((error as Error).message);
		}
	}
	return null;
}

/** Run from the durable command queue; operation IDs survive execution retries. */
async function runInteraction(
	i: DiscordInteraction,
	env: InteractionEnv,
	enqueueBackfill?: EnqueueBackfill,
): Promise<MessagePayload> {
	validateInputs(i);
	const db = new Database(env.DB);
	const uid = userId(i);
	const guild = i.guild_id;
	if (!guild || !/^\d{1,20}$/.test(uid))
		return message("Use this command in a server.");
	const custom = i.data?.custom_id ?? "";
	const command = i.data?.name;
	const sub = subcommand(i);
	const f = fields(i);
	if (command === "balance") {
		const target = String(option(i, "user") ?? uid);
		if (!/^\d{1,20}$/.test(target)) return message("Invalid user.");
		const b = await db.getBalance(target);
		return message(
			`<@${target}> has ${formatUnits(b.balanceUnits)} coins. Available: ${formatUnits(b.availableUnits)} | Locked: ${formatUnits(b.lockedUnits)}`,
		);
	}
	if (command === "leaderboard" || custom.startsWith("leaderboard:")) {
		const current = custom ? page(i) : 0;
		const data = await db.getLeaderboardPaginated(current);
		return {
			...message(
				data.entries
					.map(
						(e) =>
							`${e.rank}. <@${e.discord_id}> — ${formatUnits(e.balanceUnits)} coins`,
					)
					.join("\n") || "No coins earned yet.",
			),
			components: pagination("leaderboard", current, data.hasMore),
		};
	}
	if (command === "backfill") {
		if (!isAdmin(i)) return message("Administrator permission is required.");
		const limit = Number(option(i, "limit") ?? 1000);
		if (!Number.isSafeInteger(limit) || limit < 100 || limit > 1000)
			return message("Backfill limit must be 100-1000 messages per channel.");
		const data = { guildId: guild, limit, reset: option(i, "reset") === true };
		if (enqueueBackfill) {
			if (!(await enqueueBackfill(data)))
				throw new Error("Backfill queue unavailable");
		} else {
			const result = await env.GATEWAY.get(
				env.GATEWAY.idFromName("discord"),
			).fetch("https://gateway/backfill", {
				method: "POST",
				body: JSON.stringify({ ...data, interactionId: i.id }),
			});
			await result.body?.cancel();
			if (!result.ok) throw new Error("Backfill queue unavailable");
		}
		return message(
			"Backfill queued (one channel at a time, up to 1000 messages per channel). Existing reaction awards are deduplicated.",
		);
	}
	if (custom === "market:create:binary" || custom === "market:create:multi") {
		const outcomes = custom.endsWith("binary")
			? ["Yes", "No"]
			: (f.options ?? "")
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
		const oracle = f.oracle || uid;
		if (
			!/^\d{1,20}$/.test(oracle) ||
			!f.description?.trim() ||
			f.description.length > 500 ||
			outcomes.length < 2 ||
			outcomes.length > 10 ||
			new Set(outcomes).size !== outcomes.length ||
			outcomes.some((o) => o.length > 100)
		)
			return message(
				"Provide a prediction, valid oracle ID, and 2-10 distinct choices (100 characters each).",
			);
		const market = await db.createMarket(
			{
				guildId: guild,
				creatorId: uid,
				oracleUserId: oracle,
				description: f.description.trim(),
				outcomeDescriptions: outcomes,
			},
			`interaction:${i.id}`,
		);
		return message(
			`Market #${market.number} created: ${market.description}\nOracle: <@${oracle}>\n${market.outcomes.map((o) => o.description).join(", ")}`,
		);
	}
	if (
		(command === "market" && sub === "list") ||
		custom.startsWith("markets:")
	) {
		const current = custom ? page(i) : 0;
		const status = String(custom.split(":")[3] ?? option(i, "status") ?? "all");
		const data = await db.getGuildMarketsPaginated(
			guild,
			current,
			5,
			status === "open" || status === "resolved" ? status : undefined,
		);
		return {
			...message(
				data.markets
					.map(
						(m) =>
							`#${m.number} ${m.description}\n${m.status} | Oracle <@${m.oracleUserId}> | ${m.outcomes.map((o) => o.description).join(", ")}`,
					)
					.join("\n\n") || "No markets found.",
			),
			components: pagination("markets", current, data.hasMore, `:${status}`),
		};
	}
	if (command === "market" && sub === "positions") {
		const ps = await db.getUserPositions(uid, guild);
		return message(
			ps
				.map(
					(p) =>
						`#${p.marketNumber} ${p.marketDescription}: ${Object.entries(
							p.holdings,
						)
							.map(([id, q]) => `${id}: ${formatShareUnits(q)}`)
							.join(
								", ",
							)}${p.order ? ` | ${p.order.direction} ${formatShareUnits(p.order.quantityUnits)} @ ${formatPriceUnits(p.order.priceUnits)}` : ""}`,
				)
				.join("\n") || "No positions or orders.",
		);
	}
	const parts = custom.split(":");
	const marketId = custom.startsWith("market:quickorder:confirm:")
		? parts[3]
		: custom.startsWith("market:resolve:")
			? parts[2]
			: String(option(i, "market") ?? "");
	if (!marketId) return message("Unknown command.");
	const market = await scopedMarket(db, i, marketId);
	if (
		(command === "market" && sub === "resolve") ||
		custom.startsWith("market:resolve:")
	) {
		if (market.oracleUserId !== uid)
			return message("You are not the oracle for this market.");
		if (market.status !== "open") return message("Market already resolved.");
		if (!custom)
			return {
				...message(`Resolve #${market.number}: ${market.description}`),
				components: [
					row([
						{
							type: 3,
							custom_id: `market:resolve:${market.id}`,
							options: market.outcomes.map((o) => ({
								label: o.description.slice(0, 100),
								value: o.id,
							})),
						},
					]),
				],
			};
		const winner = i.data?.values?.[0];
		if (!winner || !market.outcomes.some((o) => o.id === winner))
			return message("Invalid winning outcome.");
		const result = await db.resolveMarket(
			market.id,
			winner,
			`interaction:${i.id}`,
		);
		return message(
			result ? "Market resolved and balances settled." : "Unable to resolve.",
		);
	}
	if (command === "market" && sub === "cancel") {
		const result = await db.cancelOrder(uid, market.id, `interaction:${i.id}`);
		return message(
			result.success
				? "Order cancelled; escrow released."
				: (result.error ?? "Unable to cancel."),
		);
	}
	if (
		(command === "market" && sub === "order") ||
		custom.startsWith("market:quickorder:confirm:")
	) {
		const outcome = custom ? parts[4] : String(option(i, "outcome") ?? "");
		const direction = String(
			custom ? f.direction : option(i, "direction"),
		).toLowerCase();
		const quantity = Number(custom ? f.quantity : option(i, "quantity"));
		const price = parsePriceToUnits(
			Number(custom ? f.price : option(i, "price")),
		);
		if (
			!market.outcomes.some((o) => o.id === outcome) ||
			!["buy", "sell"].includes(direction) ||
			!Number.isSafeInteger(quantity) ||
			quantity < 1 ||
			quantity > 1000 ||
			price === null
		)
			return message(
				"Invalid outcome, direction, quantity (1-1000), or price (0.01-0.99, two decimals).",
			);
		const result = await db.createOrder(
			uid,
			market.id,
			outcome,
			direction as "buy" | "sell",
			quantity,
			price,
			`interaction:${i.id}`,
		);
		if (!result.success) return message(result.error ?? "Order rejected.");
		await db.executeMarket(market.id, `interaction:${i.id}:match`);
		return message(
			`Order placed: ${direction} ${quantity} @ ${formatPriceUnits(price)}.`,
		);
	}
	if (command === "market" && sub === "view") {
		const orders = await db.getMarketOrders(market.id);
		const outcomesById = new Map(
			market.outcomes.map((outcome) => [outcome.id, outcome]),
		);
		const outcomeLabel = (outcome: { description: string; number: number }) => {
			if (outcome.description.length <= 80) return outcome.description;
			const prefix = `#${outcome.number} `;
			return `${prefix}${outcome.description.slice(0, 80 - prefix.length - 3)}...`;
		};
		const orderBook =
			orders
				.map((order) => {
					const outcome = outcomesById.get(order.outcomeId);
					const label = outcome ? outcomeLabel(outcome) : "Unknown outcome";
					return `${label}: ${order.direction} ${formatShareUnits(order.quantityUnits)} @ ${formatPriceUnits(order.priceUnits)}`;
				})
				.join("\n") || "No active orders.";
		return {
			...message(
				`#${market.number} ${market.description}\n${market.status} | Oracle <@${market.oracleUserId}>\n${market.outcomes.map((o) => o.description).join(", ")}\n${orderBook}`,
			),
			components:
				market.status === "open"
					? market.outcomes.slice(0, 25).reduce<unknown[]>((rs, o, index) => {
							if (index % 5 === 0) rs.push(row([]));
							(rs.at(-1) as { components: unknown[] }).components.push(
								button(
									`market:quickorder:${market.id}:${o.id}`,
									outcomeLabel(o),
								),
							);
							return rs;
						}, [])
					: [],
		};
	}
	return message("Unknown command.");
}

export async function executeInteraction(
	i: DiscordInteraction,
	env: InteractionEnv,
	enqueueBackfill?: EnqueueBackfill,
): Promise<MessagePayload> {
	try {
		return await runInteraction(i, env, enqueueBackfill);
	} catch (error) {
		if (error instanceof InteractionInputError) return message(error.message);
		throw error;
	}
}
