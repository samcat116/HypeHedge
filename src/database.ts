import {
	type ShareUnits,
	UNIT_SCALE,
	addUnits,
	contractsToShareUnits,
	formatUnits,
	parseHoldings,
} from "./accounting.js";
import { D1QueryBudgetExceeded } from "./cloudflare/d1-budget.js";
import {
	type Direction,
	type Execution,
	type Position,
	calculateEscrow,
	executeMatching,
	validateOrder,
} from "./exchange.js";

export interface MarketRecord {
	id: string;
	number: number;
	guildId: string;
	creatorId: string;
	description: string;
	oracleType: string;
	oracleUserId: string;
	status: "open" | "resolved";
	winningOutcomeId: string | null;
	collateralUnits: number;
	createdAt: Date;
	resolvedAt: Date | null;
}
export interface OutcomeRecord {
	id: string;
	marketId: string;
	number: number;
	description: string;
}
export interface OrderRecord {
	id: string;
	userId: string;
	marketId: string;
	outcomeId: string;
	direction: Direction;
	quantityUnits: number;
	priceUnits: number;
	escrowUnits: number;
	createdAt: Date;
}
export interface PositionRecord {
	id: string;
	userId: string;
	marketId: string;
	holdings: string;
	createdAt: Date;
	updatedAt: Date;
}
export interface MarketWithOutcomes extends MarketRecord {
	outcomes: OutcomeRecord[];
}
export interface CreateMarketParams {
	guildId: string;
	creatorId: string;
	oracleUserId: string;
	description: string;
	outcomeDescriptions: string[];
}
export interface CreateOrderResult {
	success: boolean;
	order?: OrderRecord;
	executions?: Execution[];
	error?: string;
}
export interface PayoutInfo {
	userId: string;
	shareUnits: number;
	payoutUnits: number;
}
export interface ResolveMarketResult {
	market: MarketRecord;
	payouts: PayoutInfo[];
	totalPayoutUnits: number;
	winnerCount: number;
}
export interface LeaderboardEntry {
	discord_id: string;
	balanceUnits: number;
	rank: number;
}
export interface PaginatedLeaderboard {
	entries: LeaderboardEntry[];
	totalCount: number;
	hasMore: boolean;
}
export interface PaginatedMarkets {
	markets: MarketWithOutcomes[];
	totalCount: number;
	hasMore: boolean;
}
export interface UserPositionView {
	marketId: string;
	marketNumber: number;
	marketDescription: string;
	marketStatus: string;
	holdings: Record<string, ShareUnits>;
	order: OrderRecord | null;
}
export interface ReactionBatchItem {
	messageId: string;
	reactorId: string;
	authorId: string;
	emoji: string;
}
export interface BackfillProgressRecord {
	guildId: string;
	channelId: string;
	lastMessageId: string | null;
	messagesProcessed: number;
	reactionsAdded: number;
	status: string;
	updatedAt: Date;
}
// biome-ignore lint/suspicious/noExplicitAny: This private SQL projection adapter maps heterogeneous rows; public APIs expose explicit records.
type Row = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: SQL aliases are narrowed at each public query API.
const aliases = (r: Row): any =>
	Object.fromEntries(
		Object.entries(r).map(([k, v]) => [
			k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
			["created_at", "updated_at", "resolved_at"].includes(k) && v !== null
				? new Date(v as number)
				: v,
		]),
	);
const MAX_MARKET_PARTICIPANTS = 80;
/** Fresh D1 ledger. A global revision makes all reads in a mutation an optimistic
 * snapshot. Every writer MUST go through mutate; reads are never a transaction.
 * CAS, effects, invariant assertions and receipt execute in one atomic D1 batch. */
export class Database {
	constructor(readonly db: D1Database) {}
	private sql(q: string, ...values: unknown[]) {
		return this.db.prepare(q).bind(...values);
	}
	// biome-ignore lint/suspicious/noExplicitAny: Private SQL projection boundary.
	private async rows(q: string, ...v: unknown[]): Promise<any[]> {
		return (await this.sql(q, ...v).all<Row>()).results.map(aliases);
	}
	// biome-ignore lint/suspicious/noExplicitAny: Private SQL projection boundary.
	private async one(q: string, ...v: unknown[]): Promise<any | null> {
		return (await this.rows(q, ...v))[0] ?? null;
	}
	private assertion(q: string, ...v: unknown[]) {
		return this.sql(
			`INSERT INTO operation_assertions(ok) SELECT CASE WHEN (${q}) THEN 1 ELSE 0 END`,
			...v,
		);
	}
	private async mutate<T>(
		kind: string,
		request: unknown,
		operationId: string | undefined,
		build: (statements: D1PreparedStatement[]) => Promise<T>,
	): Promise<T> {
		const id = operationId ?? crypto.randomUUID();
		const encoded = JSON.stringify(request);
		for (let attempt = 0; attempt < 12; attempt++) {
			const receipt = await this.one(
				"SELECT * FROM operation_receipts WHERE id=?",
				id,
			);
			if (receipt) {
				if (receipt.kind !== kind || receipt.request !== encoded)
					throw new Error("Operation ID reused with different request");
				return JSON.parse(receipt.result, (key, value) =>
					["createdAt", "resolvedAt", "updatedAt"].includes(key) &&
					typeof value === "string"
						? new Date(value)
						: value,
				) as T;
			}
			const revision = await this.one(
				"SELECT version FROM revision WHERE id=1",
			);
			const statements: D1PreparedStatement[] = [];
			let result: T;
			try {
				result = await build(statements);
			} catch (error) {
				if (error instanceof D1QueryBudgetExceeded) throw error;
				if (
					(await this.one("SELECT version FROM revision WHERE id=1"))
						.version !== revision.version
				)
					continue;
				throw error;
			}
			const batch = [
				this.sql(
					"UPDATE revision SET version=version+1 WHERE id=1 AND version=?",
					revision.version,
				),
				this.assertion("changes()=1"),
				...statements,
				this.assertion(
					"NOT EXISTS(SELECT 1 FROM users u WHERE u.locked_units != COALESCE((SELECT sum(o.escrow_units) FROM orders o WHERE o.user_id=u.discord_id),0))",
				),
				this.sql(
					"INSERT INTO operation_receipts(id,kind,request,result,created_at) VALUES(?,?,?,?,?)",
					id,
					kind,
					encoded,
					JSON.stringify(result),
					Date.now(),
				),
				this.sql("DELETE FROM operation_assertions"),
			];
			try {
				await this.db.batch(batch);
				return result;
			} catch (error) {
				if (error instanceof D1QueryBudgetExceeded) throw error;
				// Only stale snapshot/competing identical operation is retried. Real SQL or
				// invariant failures are visible rather than hidden behind generic retries.
				const latest = await this.one(
					"SELECT version FROM revision WHERE id=1",
				);
				if (latest.version === revision.version) throw error;
			}
		}
		throw new Error("Ledger busy; retry the same operation ID");
	}
	async initDatabase() {
		await this.one("SELECT version FROM revision WHERE id=1");
	}
	async getBalance(id: string) {
		const u = await this.one("SELECT * FROM users WHERE discord_id=?", id);
		const balanceUnits = u?.balanceUnits ?? 0;
		const lockedUnits = u?.lockedUnits ?? 0;
		return {
			balanceUnits,
			lockedUnits,
			availableUnits: balanceUnits - lockedUnits,
		};
	}
	async addReaction(
		messageId: string,
		reactorId: string,
		authorId: string,
		emoji: string,
		operationId?: string,
	): Promise<boolean> {
		return this.mutate(
			"reaction-add",
			{ messageId, reactorId, authorId, emoji },
			operationId,
			async (s) => {
				const r = await this.one(
					"SELECT * FROM reactions WHERE message_id=? AND reactor_id=? AND emoji=?",
					messageId,
					reactorId,
					emoji,
				);
				if (r?.active) return false;
				if (r && r.authorId !== authorId)
					throw new Error("Reaction author mismatch");
				const credit = UNIT_SCALE - (r?.creditedUnits ?? 0);
				s.push(
					this.sql(
						"INSERT INTO users(discord_id,balance_units) VALUES(?,?) ON CONFLICT(discord_id) DO UPDATE SET balance_units=balance_units+excluded.balance_units",
						authorId,
						credit,
					),
				);
				s.push(
					this.sql(
						"INSERT INTO reactions VALUES(?,?,?,?,1,10000) ON CONFLICT(message_id,reactor_id,emoji) DO UPDATE SET active=1,credited_units=10000",
						messageId,
						reactorId,
						emoji,
						authorId,
					),
				);
				return true;
			},
		);
	}
	async removeReaction(
		messageId: string,
		reactorId: string,
		emoji: string,
		operationId?: string,
	): Promise<boolean> {
		return this.mutate(
			"reaction-remove",
			{ messageId, reactorId, emoji },
			operationId,
			async (s) => {
				const r = await this.one(
					"SELECT * FROM reactions WHERE message_id=? AND reactor_id=? AND emoji=?",
					messageId,
					reactorId,
					emoji,
				);
				if (!r?.active) return false;
				const b = await this.getBalance(r.authorId);
				const debit = Math.min(b.availableUnits, r.creditedUnits);
				s.push(
					this.sql(
						"UPDATE users SET balance_units=balance_units-? WHERE discord_id=?",
						debit,
						r.authorId,
					),
				);
				s.push(
					this.sql(
						"UPDATE reactions SET active=0,credited_units=credited_units-? WHERE message_id=? AND reactor_id=? AND emoji=?",
						debit,
						messageId,
						reactorId,
						emoji,
					),
				);
				return true;
			},
		);
	}
	async addReactionsBatch(items: ReactionBatchItem[], operationId?: string) {
		let n = 0;
		for (let i = 0; i < items.length; i++) {
			const r = items[i];
			if (
				await this.addReaction(
					r.messageId,
					r.reactorId,
					r.authorId,
					r.emoji,
					operationId ? `${operationId}:${i}` : undefined,
				)
			)
				n++;
		}
		return n;
	}
	async getLeaderboard(limit = 10) {
		return (await this.getLeaderboardPaginated(0, limit)).entries;
	}
	async getLeaderboardPaginated(
		page: number,
		pageSize = 10,
	): Promise<PaginatedLeaderboard> {
		const rows = await this.rows(
			"SELECT discord_id,balance_units FROM users WHERE balance_units>0 ORDER BY balance_units DESC,discord_id LIMIT ? OFFSET ?",
			pageSize,
			page * pageSize,
		);
		const totalCount = (
			await this.one(
				"SELECT count(*) AS count FROM users WHERE balance_units>0",
			)
		).count;
		return {
			entries: rows.map((r, i) => ({
				discord_id: r.discordId,
				balanceUnits: r.balanceUnits,
				rank: page * pageSize + i + 1,
			})),
			totalCount,
			hasMore: (page + 1) * pageSize < totalCount,
		};
	}
	async createMarket(
		p: CreateMarketParams,
		operationId?: string,
	): Promise<MarketWithOutcomes> {
		if (
			p.outcomeDescriptions.length < 2 ||
			p.outcomeDescriptions.length > 10 ||
			!p.description.trim() ||
			p.description.length > 1000 ||
			p.outcomeDescriptions.some((o) => !o.trim() || o.length > 100)
		)
			throw new Error("Market needs 2–10 outcomes and bounded descriptions");
		return this.mutate("market-create", p, operationId, async (s) => {
			const id = crypto.randomUUID();
			const now = Date.now();
			const number = (
				await this.one(
					"SELECT COALESCE(max(number),0)+1 AS number FROM markets",
				)
			).number;
			const outcomes = p.outcomeDescriptions.map((description, i) => ({
				id: crypto.randomUUID(),
				marketId: id,
				number: i + 1,
				description,
			}));
			s.push(
				this.sql(
					"INSERT INTO markets(id,number,guild_id,creator_id,description,oracle_user_id,created_at) VALUES(?,?,?,?,?,?,?)",
					id,
					number,
					p.guildId,
					p.creatorId,
					p.description,
					p.oracleUserId,
					now,
				),
			);
			for (const o of outcomes)
				s.push(
					this.sql(
						"INSERT INTO outcomes(id,market_id,number,description) VALUES(?,?,?,?)",
						o.id,
						id,
						o.number,
						o.description,
					),
				);
			return {
				id,
				number,
				guildId: p.guildId,
				creatorId: p.creatorId,
				description: p.description,
				oracleUserId: p.oracleUserId,
				oracleType: "manual",
				status: "open",
				winningOutcomeId: null,
				collateralUnits: 0,
				createdAt: new Date(now),
				resolvedAt: null,
				outcomes,
			};
		});
	}
	async getMarket(id: string): Promise<MarketWithOutcomes | null> {
		return (await this.projectMarkets("m.id=?", [id]))[0] ?? null;
	}
	/** Project outcomes in the same SQL statement rather than one D1 call per market. */
	private async projectMarkets(
		where: string,
		args: unknown[],
		suffix = "",
	): Promise<MarketWithOutcomes[]> {
		const rows = await this.rows(
			`SELECT m.*,(SELECT json_group_array(json_object('id',o.id,'marketId',o.market_id,'number',o.number,'description',o.description)) FROM (SELECT * FROM outcomes WHERE market_id=m.id ORDER BY number) o) AS outcomes_json FROM markets m WHERE ${where} ${suffix}`,
			...args,
		);
		return rows.map(
			({ outcomesJson, ...market }) =>
				({
					...market,
					outcomes: JSON.parse(outcomesJson),
				}) as MarketWithOutcomes,
		);
	}
	async getMarketByNumber(guild: string, n: number) {
		return (
			(
				await this.projectMarkets("m.guild_id=? AND m.number=?", [guild, n])
			)[0] ?? null
		);
	}
	async getGuildMarketsPaginated(
		guild: string,
		page: number,
		pageSize = 5,
		status?: "open" | "resolved",
	): Promise<PaginatedMarkets> {
		const where = status ? "guild_id=? AND status=?" : "guild_id=?";
		const args = status ? [guild, status] : [guild];
		const markets = await this.projectMarkets(
			where,
			[...args, pageSize, page * pageSize],
			"ORDER BY m.number DESC LIMIT ? OFFSET ?",
		);
		const totalCount = (
			await this.one(
				`SELECT count(*) AS count FROM markets WHERE ${where}`,
				...args,
			)
		).count;
		return {
			markets,
			totalCount,
			hasMore: (page + 1) * pageSize < totalCount,
		};
	}
	async getGuildOpenMarkets(guild: string) {
		return (await this.getGuildMarketsPaginated(guild, 0, 100, "open")).markets;
	}
	async getOracleOpenMarkets(guild: string, oracle: string) {
		return this.projectMarkets(
			"m.guild_id=? AND m.status='open' AND m.oracle_user_id=?",
			[guild, oracle],
			"ORDER BY m.number DESC",
		);
	}
	async getOrder(user: string, market: string): Promise<OrderRecord | null> {
		return this.one(
			"SELECT * FROM orders WHERE user_id=? AND market_id=?",
			user,
			market,
		);
	}
	async getUserOrders(user: string): Promise<OrderRecord[]> {
		return this.rows("SELECT * FROM orders WHERE user_id=?", user);
	}
	async getMarketOrders(market: string): Promise<OrderRecord[]> {
		return this.rows(
			"SELECT * FROM orders WHERE market_id=? ORDER BY created_at,id",
			market,
		);
	}
	async getPosition(user: string, market: string): Promise<Position | null> {
		const p = await this.one(
			"SELECT * FROM positions WHERE user_id=? AND market_id=?",
			user,
			market,
		);
		return p
			? { userId: user, marketId: market, holdings: parseHoldings(p.holdings) }
			: null;
	}
	async getUserPositions(
		user: string,
		guild?: string,
	): Promise<UserPositionView[]> {
		const rows = await this.rows(
			`SELECT m.id AS market_id,COALESCE(p.holdings,'{}') AS holdings,m.number AS market_number,m.description AS market_description,m.status AS market_status,CASE WHEN o.id IS NULL THEN NULL ELSE json_object('id',o.id,'userId',o.user_id,'marketId',o.market_id,'outcomeId',o.outcome_id,'direction',o.direction,'quantityUnits',o.quantity_units,'priceUnits',o.price_units,'escrowUnits',o.escrow_units,'createdAt',o.created_at) END AS order_json FROM markets m LEFT JOIN positions p ON p.market_id=m.id AND p.user_id=? LEFT JOIN orders o ON o.market_id=m.id AND o.user_id=? WHERE (EXISTS(SELECT 1 FROM json_each(p.holdings) WHERE value>0) OR o.id IS NOT NULL) ${guild ? "AND m.guild_id=?" : ""} ORDER BY m.number DESC`,
			user,
			user,
			...(guild ? [guild] : []),
		);
		return rows.map(({ orderJson, ...p }) => {
			const order = orderJson ? JSON.parse(orderJson) : null;
			if (order) order.createdAt = new Date(order.createdAt);
			return {
				...p,
				holdings: parseHoldings(p.holdings),
				order,
			} as UserPositionView;
		});
	}
	async getUserMarketsWithOrders(user: string, guild: string) {
		return this.projectMarkets(
			"m.guild_id=? AND EXISTS(SELECT 1 FROM orders o WHERE o.market_id=m.id AND o.user_id=?)",
			[guild, user],
			"ORDER BY m.number DESC",
		);
	}
	async createOrder(
		userId: string,
		marketId: string,
		outcomeId: string,
		direction: Direction,
		quantity: number,
		priceUnits: number,
		operationId?: string,
	): Promise<CreateOrderResult> {
		let quantityUnits: number;
		try {
			quantityUnits = contractsToShareUnits(quantity);
		} catch {
			return {
				success: false,
				error: "Quantity must be a positive safe integer",
			};
		}
		const validation = validateOrder(direction, quantityUnits, priceUnits);
		if (!validation.valid) return { success: false, error: validation.error };
		return this.mutate(
			"order-create",
			{ userId, marketId, outcomeId, direction, quantity, priceUnits },
			operationId,
			async (s) => {
				const m = await this.getMarket(marketId);
				if (!m || m.status !== "open")
					return { success: false, error: "Market not open" };
				if (!m.outcomes.some((o) => o.id === outcomeId))
					return { success: false, error: "Invalid outcome" };
				if (await this.getOrder(userId, marketId))
					return {
						success: false,
						error: "You already have an order in this market. Cancel it first.",
					};
				const participantCount = (
					await this.one(
						"SELECT count(DISTINCT user_id) AS count FROM (SELECT user_id FROM orders WHERE market_id=? UNION SELECT user_id FROM positions WHERE market_id=? AND EXISTS(SELECT 1 FROM json_each(positions.holdings) WHERE value>0))",
						marketId,
						marketId,
					)
				).count;
				const position = await this.getPosition(userId, marketId);
				if (
					participantCount >= MAX_MARKET_PARTICIPANTS &&
					!Object.values(position?.holdings ?? {}).some((units) => units > 0)
				)
					return { success: false, error: "Market participant limit reached" };
				const holdings = position?.holdings ?? {};
				const escrowUnits = calculateEscrow(
					direction,
					quantityUnits,
					priceUnits,
					holdings[outcomeId] ?? 0,
				);
				const b = await this.getBalance(userId);
				if (b.availableUnits < escrowUnits)
					return {
						success: false,
						error: `Insufficient balance. Need ${formatUnits(escrowUnits)}, have ${formatUnits(b.availableUnits)} available`,
					};
				const id = crypto.randomUUID();
				const now = Date.now();
				s.push(
					this.sql(
						"INSERT INTO users(discord_id) VALUES(?) ON CONFLICT DO NOTHING",
						userId,
					),
					this.sql(
						"UPDATE users SET locked_units=locked_units+? WHERE discord_id=? AND balance_units-locked_units>=?",
						escrowUnits,
						userId,
						escrowUnits,
					),
					this.assertion("changes()=1"),
				);
				s.push(
					this.sql(
						"INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?)",
						id,
						userId,
						marketId,
						outcomeId,
						direction,
						quantityUnits,
						priceUnits,
						escrowUnits,
						now,
					),
				);
				return {
					success: true,
					order: {
						id,
						userId,
						marketId,
						outcomeId,
						direction,
						quantityUnits,
						priceUnits,
						escrowUnits,
						createdAt: new Date(now),
					},
				};
			},
		);
	}
	async cancelOrder(userId: string, marketId: string, operationId?: string) {
		return this.mutate(
			"order-cancel",
			{ userId, marketId },
			operationId,
			async (s) => {
				const o = await this.getOrder(userId, marketId);
				if (!o)
					return { success: false, error: "No order found in this market" };
				s.push(
					this.sql(
						"UPDATE users SET locked_units=locked_units-? WHERE discord_id=?",
						o.escrowUnits,
						userId,
					),
					this.assertion("changes()=1"),
					this.sql("DELETE FROM orders WHERE id=?", o.id),
					this.assertion("changes()=1"),
				);
				return { success: true };
			},
		);
	}
	async executeMarket(
		marketId: string,
		operationId?: string,
	): Promise<{ executions: Execution[]; error?: string }> {
		return this.mutate(
			"market-execute",
			{ marketId },
			operationId,
			async (s) => {
				const m = await this.getMarket(marketId);
				if (!m || m.status !== "open")
					return { executions: [], error: "Market not open" };
				const orders = await this.getMarketOrders(marketId);
				const positions = await this.rows(
					"SELECT * FROM positions WHERE market_id=? AND EXISTS(SELECT 1 FROM json_each(positions.holdings) WHERE value>0)",
					marketId,
				);
				const match = executeMatching(
					orders,
					positions.map((p) => ({
						userId: p.userId,
						marketId,
						holdings: parseHoldings(p.holdings),
					})),
					m.outcomes.map((o) => o.id),
					marketId,
				);
				let collateralDelta = 0;
				for (const u of match.balanceUpdates) {
					collateralDelta = addUnits(collateralDelta, -u.balanceUnitsDelta);
				}
				if (match.balanceUpdates.length)
					s.push(
						this.sql(
							`WITH updates AS (
                          SELECT json_extract(value,'$.userId') AS user,
                                 json_extract(value,'$.balanceUnitsDelta') AS balance_delta,
                                 json_extract(value,'$.lockedUnitsDelta') AS locked_delta FROM json_each(?)
                        ) UPDATE users SET
                          balance_units=balance_units+(SELECT balance_delta FROM updates WHERE user=discord_id),
                          locked_units=locked_units+(SELECT locked_delta FROM updates WHERE user=discord_id)
                        WHERE discord_id IN (SELECT user FROM updates)`,
							JSON.stringify(match.balanceUpdates),
						),
						this.assertion("changes()=?", match.balanceUpdates.length),
					);
				if (collateralDelta < 0)
					throw new Error("Matching creates unfunded currency");
				s.push(
					this.sql(
						"UPDATE markets SET collateral_units=collateral_units+? WHERE id=?",
						collateralDelta,
						marketId,
					),
				);
				const changed = new Map<string, Record<string, number>>();
				for (const u of match.positionUpdates) {
					const h =
						changed.get(u.userId) ??
						parseHoldings(
							positions.find((p) => p.userId === u.userId)?.holdings ?? "{}",
						);
					h[u.outcomeId] = addUnits(h[u.outcomeId] ?? 0, u.quantityUnitsDelta);
					if (h[u.outcomeId] === 0) delete h[u.outcomeId];
					changed.set(u.userId, h);
				}
				if (changed.size) {
					s.push(
						this.sql(
							`INSERT INTO positions(id,user_id,market_id,holdings,created_at,updated_at)
                          SELECT json_extract(value,'$.id'),json_extract(value,'$.user'),?,
                                 json_extract(value,'$.holdings'),?,? FROM json_each(?) WHERE true
                          ON CONFLICT(user_id,market_id) DO UPDATE SET holdings=excluded.holdings,updated_at=excluded.updated_at`,
							marketId,
							Date.now(),
							Date.now(),
							JSON.stringify(
								[...changed].map(([user, h]) => ({
									id: crypto.randomUUID(),
									user,
									holdings: JSON.stringify(h),
								})),
							),
						),
						this.assertion("changes()=?", changed.size),
					);
				}
				// A trader who sells every share no longer occupies a participant slot.
				// Prune historical {} and zero-only JSON rows in the same guarded batch.
				s.push(
					this.sql(
						"DELETE FROM positions WHERE market_id=? AND NOT EXISTS(SELECT 1 FROM json_each(positions.holdings) WHERE value>0)",
						marketId,
					),
				);
				const removed = match.orderUpdates.filter(
					(u) => u.newQuantityUnits === 0,
				);
				const remaining = match.orderUpdates.filter(
					(u) => u.newQuantityUnits > 0,
				);
				if (removed.length)
					s.push(
						this.sql(
							"DELETE FROM orders WHERE id IN (SELECT value FROM json_each(?))",
							JSON.stringify(removed.map((u) => u.orderId)),
						),
						this.assertion("changes()=?", removed.length),
					);
				if (remaining.length)
					s.push(
						this.sql(
							`WITH updates AS (
                          SELECT json_extract(value,'$.orderId') AS id,
                                 json_extract(value,'$.newQuantityUnits') AS quantity,
                                 json_extract(value,'$.newEscrowUnits') AS escrow FROM json_each(?)
                        ) UPDATE orders SET
                          quantity_units=(SELECT quantity FROM updates WHERE updates.id=orders.id),
                          escrow_units=(SELECT escrow FROM updates WHERE updates.id=orders.id)
                        WHERE id IN (SELECT id FROM updates)`,
							JSON.stringify(remaining),
						),
						this.assertion("changes()=?", remaining.length),
					);
				if (match.executions.length)
					s.push(
						this.sql(
							`INSERT INTO executions(id,market_id,timestamp,participants)
                        SELECT json_extract(value,'$.id'),?,json_extract(value,'$.timestamp'),json_extract(value,'$.participants')
                        FROM json_each(?)`,
							marketId,
							JSON.stringify(match.executions),
						),
						this.assertion("changes()=?", match.executions.length),
					);
				// Every outcome in an open market must have exactly the funded basket supply.
				s.push(
					this.assertion(
						"NOT EXISTS(SELECT 1 FROM outcomes o WHERE o.market_id=? AND (SELECT collateral_units FROM markets WHERE id=?) != COALESCE((SELECT sum(j.value) FROM positions p,json_each(p.holdings) j WHERE p.market_id=? AND j.key=o.id),0))",
						marketId,
						marketId,
						marketId,
					),
				);
				return { executions: match.executions };
			},
		);
	}
	async resolveMarket(
		marketId: string,
		winningOutcomeId: string,
		operationId?: string,
	): Promise<ResolveMarketResult | null> {
		return this.mutate(
			"market-resolve",
			{ marketId, winningOutcomeId },
			operationId,
			async (s) => {
				const m = await this.getMarket(marketId);
				if (
					!m ||
					m.status !== "open" ||
					!m.outcomes.some((o) => o.id === winningOutcomeId)
				)
					return null;
				const orders = await this.getMarketOrders(marketId);
				const positions = await this.rows(
					"SELECT * FROM positions WHERE market_id=? AND EXISTS(SELECT 1 FROM json_each(positions.holdings) WHERE value>0)",
					marketId,
				);
				const payouts: PayoutInfo[] = [];
				const changes = new Map<string, { payout: number; unlock: number }>();
				let totalPayoutUnits = 0;
				for (const o of orders)
					changes.set(o.userId, { payout: 0, unlock: o.escrowUnits });
				for (const p of positions) {
					const amount = parseHoldings(p.holdings)[winningOutcomeId] ?? 0;
					if (amount) {
						totalPayoutUnits = addUnits(totalPayoutUnits, amount);
						payouts.push({
							userId: p.userId,
							shareUnits: amount,
							payoutUnits: amount,
						});
						const c = changes.get(p.userId) ?? { payout: 0, unlock: 0 };
						c.payout = amount;
						changes.set(p.userId, c);
					}
				}
				if (totalPayoutUnits !== m.collateralUnits)
					throw new Error(
						"Settlement collateral does not match winning supply",
					);
				// One JSON parameter keeps 80 users below D1's 100-parameter limit.
				// SQLite checks each user's exact integer balance/lock constraints;
				// the affected-count assertion aborts the entire batch if any user is missing.
				s.push(
					this.sql(
						`WITH settlement AS (
                          SELECT json_extract(value,'$.user') AS user,
                                 json_extract(value,'$.payout') AS payout,
                                 json_extract(value,'$.unlock') AS unlock FROM json_each(?)
                        ) UPDATE users SET
                          balance_units=balance_units+(SELECT payout FROM settlement WHERE user=discord_id),
                          locked_units=locked_units-(SELECT unlock FROM settlement WHERE user=discord_id)
                        WHERE discord_id IN (SELECT user FROM settlement)`,
						JSON.stringify([...changes].map(([user, c]) => ({ user, ...c }))),
					),
					this.assertion("changes()=?", changes.size),
				);
				s.push(
					this.sql("DELETE FROM orders WHERE market_id=?", marketId),
					this.sql("DELETE FROM positions WHERE market_id=?", marketId),
				);
				const now = Date.now();
				s.push(
					this.sql(
						"UPDATE markets SET status='resolved',winning_outcome_id=?,resolved_at=?,collateral_units=0 WHERE id=? AND status='open'",
						winningOutcomeId,
						now,
						marketId,
					),
					this.assertion("changes()=1"),
				);
				return {
					market: {
						...m,
						status: "resolved",
						winningOutcomeId,
						resolvedAt: new Date(now),
						collateralUnits: 0,
					},
					payouts,
					totalPayoutUnits,
					winnerCount: payouts.length,
				};
			},
		);
	}
	async getOrCreateChannelProgress(
		guildId: string,
		channelId: string,
	): Promise<BackfillProgressRecord> {
		const p = await this.one(
			"SELECT * FROM backfill_progress WHERE guild_id=? AND channel_id=?",
			guildId,
			channelId,
		);
		if (p) return p;
		await this.mutate(
			"backfill-init",
			{ guildId, channelId },
			undefined,
			async (s) => {
				s.push(
					this.sql(
						"INSERT INTO backfill_progress(guild_id,channel_id,updated_at) VALUES(?,?,?) ON CONFLICT DO NOTHING",
						guildId,
						channelId,
						Date.now(),
					),
				);
				return true;
			},
		);
		const created = await this.one(
			"SELECT * FROM backfill_progress WHERE guild_id=? AND channel_id=?",
			guildId,
			channelId,
		);
		if (!created) throw new Error("Backfill progress disappeared");
		return created;
	}
	async getGuildBackfillProgress(
		guild: string,
	): Promise<BackfillProgressRecord[]> {
		return this.rows("SELECT * FROM backfill_progress WHERE guild_id=?", guild);
	}
	async updateChannelProgress(
		guild: string,
		channel: string,
		last: string,
		messages: number,
		reactions: number,
		operationId?: string,
	) {
		await this.mutate(
			"backfill-update",
			{ guild, channel, last, messages, reactions },
			operationId,
			async (s) => {
				s.push(
					this.sql(
						"UPDATE backfill_progress SET last_message_id=?,messages_processed=messages_processed+?,reactions_added=reactions_added+?,status='in_progress',updated_at=? WHERE guild_id=? AND channel_id=?",
						last,
						messages,
						reactions,
						Date.now(),
						guild,
						channel,
					),
					this.assertion("changes()=1"),
				);
				return true;
			},
		);
	}
	async markChannelCompleted(guild: string, channel: string) {
		await this.mutate(
			"backfill-complete",
			{ guild, channel },
			undefined,
			async (s) => {
				s.push(
					this.sql(
						"UPDATE backfill_progress SET status='completed',updated_at=? WHERE guild_id=? AND channel_id=?",
						Date.now(),
						guild,
						channel,
					),
				);
				return true;
			},
		);
	}
	async resetStaleProgress(guild: string) {
		await this.mutate("backfill-stale", { guild }, undefined, async (s) => {
			s.push(
				this.sql(
					"UPDATE backfill_progress SET status='pending',updated_at=? WHERE guild_id=? AND status='in_progress' AND updated_at<?",
					Date.now(),
					guild,
					Date.now() - 3600000,
				),
			);
			return true;
		});
	}
	async resetGuildBackfillProgress(guild: string) {
		await this.mutate("backfill-reset", { guild }, undefined, async (s) => {
			s.push(this.sql("DELETE FROM backfill_progress WHERE guild_id=?", guild));
			return true;
		});
	}
}
