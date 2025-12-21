import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "./db";
import {
	backfillProgress,
	executions,
	markets,
	orders,
	outcomes,
	positions,
	reactions,
	users,
} from "./db/schema";
import {
	type Direction,
	type Execution,
	type Order,
	type Party,
	type Position,
	calculateEscrow,
	calculatePayout,
	executeMatching,
	generateId,
} from "./exchange.js";
import { withSpan } from "./telemetry/index.js";
import { logger } from "./telemetry/logger.js";
import {
	dbErrorsCounter,
	dbQueryCounter,
	dbQueryDuration,
} from "./telemetry/metrics.js";

async function withDbSpan<T>(
	operation: string,
	table: string,
	fn: () => Promise<T>,
): Promise<T> {
	const startTime = performance.now();
	dbQueryCounter.add(1, { operation, table });

	return withSpan(
		`db.${operation}`,
		{
			"db.system": "postgresql",
			"db.operation": operation,
			"db.sql.table": table,
		},
		async () => {
			try {
				const result = await fn();
				return result;
			} catch (error) {
				dbErrorsCounter.add(1, { operation, table });
				logger.error(`Database error: ${operation}`, {
					table,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			} finally {
				const duration = performance.now() - startTime;
				dbQueryDuration.record(duration, { operation, table });
			}
		},
	);
}

export async function initDatabase(): Promise<void> {
	// Schema managed by drizzle-kit, just verify connection
	await withDbSpan("select", "users", async () => {
		await db.select().from(users).limit(1);
	});
	logger.info("Connected to database");
}

// ============================================================================
// Reaction-based currency functions (unchanged)
// ============================================================================

export async function addReaction(
	messageId: string,
	reactorId: string,
	authorId: string,
	emoji: string,
): Promise<boolean> {
	return withDbSpan("insert", "reactions", async () => {
		// Insert reaction, ignore if duplicate
		const result = await db
			.insert(reactions)
			.values({ messageId, reactorId, authorId, emoji })
			.onConflictDoNothing()
			.returning();

		if (result.length > 0) {
			// Upsert user balance
			await withDbSpan("upsert", "users", async () => {
				await db
					.insert(users)
					.values({ discordId: authorId, balance: 1, locked: 0 })
					.onConflictDoUpdate({
						target: users.discordId,
						set: { balance: sql`${users.balance} + 1` },
					});
			});
			return true;
		}
		return false;
	});
}

export async function removeReaction(
	messageId: string,
	reactorId: string,
	emoji: string,
): Promise<boolean> {
	return withDbSpan("delete", "reactions", async () => {
		// Get reaction to find author
		const [reaction] = await db
			.select({ authorId: reactions.authorId })
			.from(reactions)
			.where(
				and(
					eq(reactions.messageId, messageId),
					eq(reactions.reactorId, reactorId),
					eq(reactions.emoji, emoji),
				),
			);

		if (!reaction) return false;

		// Delete reaction
		await db
			.delete(reactions)
			.where(
				and(
					eq(reactions.messageId, messageId),
					eq(reactions.reactorId, reactorId),
					eq(reactions.emoji, emoji),
				),
			);

		// Decrement balance
		await withDbSpan("update", "users", async () => {
			await db
				.update(users)
				.set({ balance: sql`${users.balance} - 1` })
				.where(
					and(eq(users.discordId, reaction.authorId), gt(users.balance, 0)),
				);
		});

		return true;
	});
}

export async function getBalance(
	userId: string,
): Promise<{ balance: number; locked: number; available: number }> {
	return withDbSpan("select", "users", async () => {
		const [user] = await db
			.select({ balance: users.balance, locked: users.locked })
			.from(users)
			.where(eq(users.discordId, userId));

		const balance = user?.balance ?? 0;
		const locked = user?.locked ?? 0;
		return { balance, locked, available: balance - locked };
	});
}

export interface LeaderboardEntry {
	discord_id: string;
	balance: number;
	rank: number;
}

export async function getLeaderboard(limit = 10): Promise<LeaderboardEntry[]> {
	return withDbSpan("select", "users", async () => {
		const results = await db
			.select({
				discord_id: users.discordId,
				balance: users.balance,
			})
			.from(users)
			.where(gt(users.balance, 0))
			.orderBy(desc(users.balance))
			.limit(limit);

		return results.map((r, i) => ({ ...r, balance: r.balance, rank: i + 1 }));
	});
}

export interface PaginatedLeaderboard {
	entries: LeaderboardEntry[];
	totalCount: number;
	hasMore: boolean;
}

export async function getLeaderboardPaginated(
	page: number,
	pageSize = 10,
): Promise<PaginatedLeaderboard> {
	return withDbSpan("select", "users", async () => {
		const offset = page * pageSize;

		const [results, countResult] = await Promise.all([
			db
				.select({
					discord_id: users.discordId,
					balance: users.balance,
				})
				.from(users)
				.where(gt(users.balance, 0))
				.orderBy(desc(users.balance))
				.limit(pageSize)
				.offset(offset),
			db
				.select({ count: sql<number>`count(*)` })
				.from(users)
				.where(gt(users.balance, 0)),
		]);

		const totalCount = Number(countResult[0]?.count ?? 0);
		const entries = results.map((r, i) => ({
			...r,
			balance: r.balance,
			rank: offset + i + 1,
		}));

		return {
			entries,
			totalCount,
			hasMore: offset + entries.length < totalCount,
		};
	});
}

// ============================================================================
// Backfill progress functions (unchanged)
// ============================================================================

export type BackfillProgressRecord = typeof backfillProgress.$inferSelect;

export async function getOrCreateChannelProgress(
	guildId: string,
	channelId: string,
): Promise<BackfillProgressRecord> {
	return withDbSpan("upsert", "backfill_progress", async () => {
		const [existing] = await db
			.select()
			.from(backfillProgress)
			.where(
				and(
					eq(backfillProgress.guildId, guildId),
					eq(backfillProgress.channelId, channelId),
				),
			);

		if (existing) return existing;

		const [created] = await db
			.insert(backfillProgress)
			.values({ guildId, channelId, status: "pending" })
			.returning();

		return created;
	});
}

export async function updateChannelProgress(
	guildId: string,
	channelId: string,
	lastMessageId: string,
	messagesIncrement: number,
	reactionsIncrement: number,
): Promise<void> {
	await withDbSpan("update", "backfill_progress", async () => {
		await db
			.update(backfillProgress)
			.set({
				lastMessageId,
				messagesProcessed: sql`${backfillProgress.messagesProcessed} + ${messagesIncrement}`,
				reactionsAdded: sql`${backfillProgress.reactionsAdded} + ${reactionsIncrement}`,
				status: "in_progress",
				updatedAt: sql`now()`,
			})
			.where(
				and(
					eq(backfillProgress.guildId, guildId),
					eq(backfillProgress.channelId, channelId),
				),
			);
	});
}

export async function markChannelCompleted(
	guildId: string,
	channelId: string,
): Promise<void> {
	await withDbSpan("update", "backfill_progress", async () => {
		await db
			.update(backfillProgress)
			.set({
				status: "completed",
				updatedAt: sql`now()`,
			})
			.where(
				and(
					eq(backfillProgress.guildId, guildId),
					eq(backfillProgress.channelId, channelId),
				),
			);
	});
}

export async function getGuildBackfillProgress(
	guildId: string,
): Promise<BackfillProgressRecord[]> {
	return withDbSpan("select", "backfill_progress", async () => {
		return db
			.select()
			.from(backfillProgress)
			.where(eq(backfillProgress.guildId, guildId));
	});
}

export async function resetStaleProgress(guildId: string): Promise<void> {
	await withDbSpan("update", "backfill_progress", async () => {
		const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
		await db
			.update(backfillProgress)
			.set({ status: "pending", updatedAt: sql`now()` })
			.where(
				and(
					eq(backfillProgress.guildId, guildId),
					eq(backfillProgress.status, "in_progress"),
					lt(backfillProgress.updatedAt, oneHourAgo),
				),
			);
	});
}

export async function resetGuildBackfillProgress(
	guildId: string,
): Promise<void> {
	await withDbSpan("delete", "backfill_progress", async () => {
		await db
			.delete(backfillProgress)
			.where(eq(backfillProgress.guildId, guildId));
	});
}

export interface ReactionBatchItem {
	messageId: string;
	reactorId: string;
	authorId: string;
	emoji: string;
}

export async function addReactionsBatch(
	reactionBatch: ReactionBatchItem[],
): Promise<number> {
	if (reactionBatch.length === 0) return 0;

	return withDbSpan("batch_insert", "reactions", async () => {
		// Insert all reactions, ignoring duplicates
		const inserted = await db
			.insert(reactions)
			.values(reactionBatch)
			.onConflictDoNothing()
			.returning({ authorId: reactions.authorId });

		if (inserted.length === 0) return 0;

		// Count reactions per author for balance updates
		const authorCounts = new Map<string, number>();
		for (const { authorId } of inserted) {
			authorCounts.set(authorId, (authorCounts.get(authorId) ?? 0) + 1);
		}

		// Batch update balances
		await withDbSpan("batch_upsert", "users", async () => {
			for (const [authorId, count] of authorCounts) {
				await db
					.insert(users)
					.values({ discordId: authorId, balance: count, locked: 0 })
					.onConflictDoUpdate({
						target: users.discordId,
						set: { balance: sql`${users.balance} + ${count}` },
					});
			}
		});

		return inserted.length;
	});
}

// ============================================================================
// Market functions (P2P Exchange)
// ============================================================================

export type MarketRecord = typeof markets.$inferSelect;
export type OutcomeRecord = typeof outcomes.$inferSelect;
export type OrderRecord = typeof orders.$inferSelect;
export type PositionRecord = typeof positions.$inferSelect;

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

export async function createMarket(
	params: CreateMarketParams,
): Promise<MarketWithOutcomes> {
	return withDbSpan("insert", "markets", async () => {
		const marketId = generateId();

		// Create market
		const [market] = await db
			.insert(markets)
			.values({
				id: marketId,
				guildId: params.guildId,
				creatorId: params.creatorId,
				description: params.description,
				oracleType: "manual",
				oracleUserId: params.oracleUserId,
			})
			.returning();

		// Create outcomes
		const outcomeRecords: OutcomeRecord[] = [];
		for (let i = 0; i < params.outcomeDescriptions.length; i++) {
			const [outcome] = await db
				.insert(outcomes)
				.values({
					id: generateId(),
					marketId,
					number: i + 1,
					description: params.outcomeDescriptions[i],
				})
				.returning();
			outcomeRecords.push(outcome);
		}

		return { ...market, outcomes: outcomeRecords };
	});
}

export async function getMarket(
	marketId: string,
): Promise<MarketWithOutcomes | null> {
	return withDbSpan("select", "markets", async () => {
		const [market] = await db
			.select()
			.from(markets)
			.where(eq(markets.id, marketId));

		if (!market) return null;

		const marketOutcomes = await db
			.select()
			.from(outcomes)
			.where(eq(outcomes.marketId, marketId))
			.orderBy(outcomes.number);

		return { ...market, outcomes: marketOutcomes };
	});
}

export async function getMarketByNumber(
	guildId: string,
	marketNumber: number,
): Promise<MarketWithOutcomes | null> {
	return withDbSpan("select", "markets", async () => {
		const [market] = await db
			.select()
			.from(markets)
			.where(
				and(eq(markets.guildId, guildId), eq(markets.number, marketNumber)),
			);

		if (!market) return null;

		const marketOutcomes = await db
			.select()
			.from(outcomes)
			.where(eq(outcomes.marketId, market.id))
			.orderBy(outcomes.number);

		return { ...market, outcomes: marketOutcomes };
	});
}

export async function getGuildOpenMarkets(
	guildId: string,
): Promise<MarketWithOutcomes[]> {
	return withDbSpan("select", "markets", async () => {
		const marketRecords = await db
			.select()
			.from(markets)
			.where(and(eq(markets.guildId, guildId), eq(markets.status, "open")))
			.orderBy(desc(markets.createdAt));

		const result: MarketWithOutcomes[] = [];
		for (const market of marketRecords) {
			const marketOutcomes = await db
				.select()
				.from(outcomes)
				.where(eq(outcomes.marketId, market.id))
				.orderBy(outcomes.number);
			result.push({ ...market, outcomes: marketOutcomes });
		}

		return result;
	});
}

export async function getOracleOpenMarkets(
	guildId: string,
	oracleId: string,
): Promise<MarketWithOutcomes[]> {
	return withDbSpan("select", "markets", async () => {
		const marketRecords = await db
			.select()
			.from(markets)
			.where(
				and(
					eq(markets.guildId, guildId),
					eq(markets.oracleUserId, oracleId),
					eq(markets.status, "open"),
				),
			)
			.orderBy(desc(markets.createdAt));

		const result: MarketWithOutcomes[] = [];
		for (const market of marketRecords) {
			const marketOutcomes = await db
				.select()
				.from(outcomes)
				.where(eq(outcomes.marketId, market.id))
				.orderBy(outcomes.number);
			result.push({ ...market, outcomes: marketOutcomes });
		}

		return result;
	});
}

export interface PaginatedMarkets {
	markets: MarketWithOutcomes[];
	totalCount: number;
	hasMore: boolean;
}

export async function getGuildMarketsPaginated(
	guildId: string,
	page: number,
	pageSize = 5,
	status?: "open" | "resolved",
): Promise<PaginatedMarkets> {
	return withDbSpan("select", "markets", async () => {
		const offset = page * pageSize;
		const conditions = [eq(markets.guildId, guildId)];
		if (status) {
			conditions.push(eq(markets.status, status));
		}

		const [marketRecords, countResult] = await Promise.all([
			db
				.select()
				.from(markets)
				.where(and(...conditions))
				.orderBy(desc(markets.createdAt))
				.limit(pageSize)
				.offset(offset),
			db
				.select({ count: sql<number>`count(*)` })
				.from(markets)
				.where(and(...conditions)),
		]);

		const totalCount = Number(countResult[0]?.count ?? 0);

		// Fetch outcomes for each market
		const result: MarketWithOutcomes[] = [];
		for (const market of marketRecords) {
			const marketOutcomes = await db
				.select()
				.from(outcomes)
				.where(eq(outcomes.marketId, market.id))
				.orderBy(outcomes.number);
			result.push({ ...market, outcomes: marketOutcomes });
		}

		return {
			markets: result,
			totalCount,
			hasMore: offset + result.length < totalCount,
		};
	});
}

// ============================================================================
// Order functions
// ============================================================================

export interface CreateOrderResult {
	success: boolean;
	order?: OrderRecord;
	executions?: Execution[];
	error?: string;
}

export async function createOrder(
	userId: string,
	marketId: string,
	outcomeId: string,
	direction: Direction,
	quantity: number,
	price: number,
): Promise<CreateOrderResult> {
	return withDbSpan("transaction", "orders", async () => {
		return db.transaction(async (tx) => {
			// 1. Verify market is open
			const [market] = await tx
				.select()
				.from(markets)
				.where(eq(markets.id, marketId));

			if (!market || market.status !== "open") {
				return { success: false, error: "Market not open" };
			}

			// 2. Verify outcome exists
			const [outcome] = await tx
				.select()
				.from(outcomes)
				.where(
					and(eq(outcomes.id, outcomeId), eq(outcomes.marketId, marketId)),
				);

			if (!outcome) {
				return { success: false, error: "Invalid outcome" };
			}

			// 3. Check user doesn't already have an order in this market
			const [existingOrder] = await tx
				.select()
				.from(orders)
				.where(and(eq(orders.userId, userId), eq(orders.marketId, marketId)));

			if (existingOrder) {
				return {
					success: false,
					error: "You already have an order in this market. Cancel it first.",
				};
			}

			// 4. Get user's current holdings in this outcome
			const [position] = await tx
				.select()
				.from(positions)
				.where(
					and(eq(positions.userId, userId), eq(positions.marketId, marketId)),
				);

			const holdings: Record<string, number> = position
				? JSON.parse(position.holdings)
				: {};
			const currentlyOwned = holdings[outcomeId] ?? 0;

			// 5. Calculate escrow required
			const escrowAmount = calculateEscrow(
				direction,
				quantity,
				price,
				currentlyOwned,
			);

			// 6. Check user has sufficient available balance
			const [user] = await tx
				.select({ balance: users.balance, locked: users.locked })
				.from(users)
				.where(eq(users.discordId, userId));

			const balance = user?.balance ?? 0;
			const locked = user?.locked ?? 0;
			const available = balance - locked;

			if (available < escrowAmount) {
				return {
					success: false,
					error: `Insufficient balance. Need ${escrowAmount.toFixed(2)}, have ${available.toFixed(2)} available`,
				};
			}

			// 7. Lock the escrow amount
			await tx
				.update(users)
				.set({ locked: sql`${users.locked} + ${escrowAmount}` })
				.where(eq(users.discordId, userId));

			// 8. Create the order
			const orderId = generateId();
			const [order] = await tx
				.insert(orders)
				.values({
					id: orderId,
					userId,
					marketId,
					outcomeId,
					direction,
					quantity,
					price,
					escrowAmount,
				})
				.returning();

			return { success: true, order };
		});
	});
}

export async function cancelOrder(
	userId: string,
	marketId: string,
): Promise<{ success: boolean; error?: string }> {
	return withDbSpan("transaction", "orders", async () => {
		return db.transaction(async (tx) => {
			// 1. Find the order
			const [order] = await tx
				.select()
				.from(orders)
				.where(and(eq(orders.userId, userId), eq(orders.marketId, marketId)));

			if (!order) {
				return { success: false, error: "No order found in this market" };
			}

			// 2. Unlock escrowed funds
			await tx
				.update(users)
				.set({ locked: sql`${users.locked} - ${order.escrowAmount}` })
				.where(eq(users.discordId, userId));

			// 3. Delete the order
			await tx.delete(orders).where(eq(orders.id, order.id));

			return { success: true };
		});
	});
}

export async function getOrder(
	userId: string,
	marketId: string,
): Promise<OrderRecord | null> {
	return withDbSpan("select", "orders", async () => {
		const [order] = await db
			.select()
			.from(orders)
			.where(and(eq(orders.userId, userId), eq(orders.marketId, marketId)));

		return order ?? null;
	});
}

export async function getUserOrders(userId: string): Promise<OrderRecord[]> {
	return withDbSpan("select", "orders", async () => {
		return db.select().from(orders).where(eq(orders.userId, userId));
	});
}

export async function getMarketOrders(
	marketId: string,
): Promise<OrderRecord[]> {
	return withDbSpan("select", "orders", async () => {
		return db.select().from(orders).where(eq(orders.marketId, marketId));
	});
}

export async function getUserMarketsWithOrders(
	userId: string,
	guildId: string,
): Promise<MarketWithOutcomes[]> {
	return withDbSpan("select", "orders", async () => {
		const userOrders = await db
			.select({ marketId: orders.marketId })
			.from(orders)
			.where(eq(orders.userId, userId));

		const marketIds = userOrders.map((o) => o.marketId);
		if (marketIds.length === 0) return [];

		const result: MarketWithOutcomes[] = [];
		for (const marketId of marketIds) {
			const [market] = await db
				.select()
				.from(markets)
				.where(and(eq(markets.id, marketId), eq(markets.guildId, guildId)));

			if (market) {
				const marketOutcomes = await db
					.select()
					.from(outcomes)
					.where(eq(outcomes.marketId, marketId))
					.orderBy(outcomes.number);
				result.push({ ...market, outcomes: marketOutcomes });
			}
		}

		return result;
	});
}

// ============================================================================
// Position functions
// ============================================================================

export async function getPosition(
	userId: string,
	marketId: string,
): Promise<Position | null> {
	return withDbSpan("select", "positions", async () => {
		const [position] = await db
			.select()
			.from(positions)
			.where(
				and(eq(positions.userId, userId), eq(positions.marketId, marketId)),
			);

		if (!position) return null;

		return {
			userId: position.userId,
			marketId: position.marketId,
			holdings: JSON.parse(position.holdings),
		};
	});
}

export interface UserPositionView {
	marketId: string;
	marketNumber: number;
	marketDescription: string;
	marketStatus: string;
	holdings: Record<string, number>;
	order: OrderRecord | null;
}

export async function getUserPositions(
	userId: string,
	guildId?: string,
): Promise<UserPositionView[]> {
	return withDbSpan("select", "positions", async () => {
		const conditions = [eq(positions.userId, userId)];
		if (guildId) {
			conditions.push(eq(markets.guildId, guildId));
		}

		const userPositions = await db
			.select({
				positionId: positions.id,
				marketId: positions.marketId,
				holdings: positions.holdings,
				marketNumber: markets.number,
				marketDescription: markets.description,
				marketStatus: markets.status,
			})
			.from(positions)
			.innerJoin(markets, eq(positions.marketId, markets.id))
			.where(and(...conditions));

		const result: UserPositionView[] = [];
		for (const pos of userPositions) {
			// Get user's order in this market if any
			const [order] = await db
				.select()
				.from(orders)
				.where(
					and(eq(orders.userId, userId), eq(orders.marketId, pos.marketId)),
				);

			result.push({
				marketId: pos.marketId,
				marketNumber: pos.marketNumber,
				marketDescription: pos.marketDescription,
				marketStatus: pos.marketStatus,
				holdings: JSON.parse(pos.holdings),
				order: order ?? null,
			});
		}

		return result;
	});
}

// ============================================================================
// Execution functions
// ============================================================================

export async function executeMarket(
	marketId: string,
): Promise<{ executions: Execution[]; error?: string }> {
	return withDbSpan("transaction", "executions", async () => {
		return db.transaction(async (tx) => {
			// 1. Get market and verify it's open
			const [market] = await tx
				.select()
				.from(markets)
				.where(eq(markets.id, marketId));

			if (!market || market.status !== "open") {
				return { executions: [], error: "Market not open" };
			}

			// 2. Get all outcomes for this market
			const marketOutcomes = await tx
				.select()
				.from(outcomes)
				.where(eq(outcomes.marketId, marketId));

			const outcomeIds = marketOutcomes.map((o) => o.id);

			// 3. Get all orders for this market
			const marketOrders = await tx
				.select()
				.from(orders)
				.where(eq(orders.marketId, marketId));

			if (marketOrders.length === 0) {
				return { executions: [] };
			}

			// 4. Get all positions for this market
			const marketPositions = await tx
				.select()
				.from(positions)
				.where(eq(positions.marketId, marketId));

			// Convert to exchange types
			const orderData: Order[] = marketOrders.map((o) => ({
				id: o.id,
				userId: o.userId,
				marketId: o.marketId,
				outcomeId: o.outcomeId,
				direction: o.direction as Direction,
				quantity: o.quantity,
				price: o.price,
				escrowAmount: o.escrowAmount,
			}));

			const positionData: Position[] = marketPositions.map((p) => ({
				userId: p.userId,
				marketId: p.marketId,
				holdings: JSON.parse(p.holdings),
			}));

			// 5. Run matching algorithm
			const matchResult = executeMatching(
				orderData,
				positionData,
				outcomeIds,
				marketId,
			);

			// 6. Apply balance updates
			for (const update of matchResult.balanceUpdates) {
				await tx
					.update(users)
					.set({
						balance: sql`${users.balance} + ${update.balanceDelta}`,
						locked: sql`${users.locked} + ${update.lockedDelta}`,
					})
					.where(eq(users.discordId, update.userId));
			}

			// 7. Apply position updates
			const positionUpdatesMap = new Map<string, Map<string, number>>();
			for (const update of matchResult.positionUpdates) {
				const key = `${update.userId}:${marketId}`;
				if (!positionUpdatesMap.has(key)) {
					positionUpdatesMap.set(key, new Map());
				}
				const outcomeMap = positionUpdatesMap.get(key);
				if (outcomeMap) {
					const current = outcomeMap.get(update.outcomeId) ?? 0;
					outcomeMap.set(update.outcomeId, current + update.quantityDelta);
				}
			}

			for (const [key, outcomeMap] of positionUpdatesMap) {
				const [posUserId] = key.split(":");

				// Get existing position or create new one
				const [existingPos] = await tx
					.select()
					.from(positions)
					.where(
						and(
							eq(positions.userId, posUserId),
							eq(positions.marketId, marketId),
						),
					);

				const holdings: Record<string, number> = existingPos
					? JSON.parse(existingPos.holdings)
					: {};

				// Apply updates
				for (const [outcomeId, delta] of outcomeMap) {
					holdings[outcomeId] = (holdings[outcomeId] ?? 0) + delta;
					if (holdings[outcomeId] === 0) {
						delete holdings[outcomeId];
					}
				}

				if (existingPos) {
					await tx
						.update(positions)
						.set({
							holdings: JSON.stringify(holdings),
							updatedAt: sql`now()`,
						})
						.where(eq(positions.id, existingPos.id));
				} else {
					await tx.insert(positions).values({
						id: generateId(),
						userId: posUserId,
						marketId,
						holdings: JSON.stringify(holdings),
					});
				}
			}

			// 8. Apply order updates
			for (const update of matchResult.orderUpdates) {
				if (update.newQuantity === 0) {
					// Delete fully filled order and unlock remaining escrow
					const [order] = await tx
						.select()
						.from(orders)
						.where(eq(orders.id, update.orderId));

					if (order) {
						await tx.delete(orders).where(eq(orders.id, update.orderId));
					}
				} else {
					// Update order quantity
					await tx
						.update(orders)
						.set({ quantity: update.newQuantity })
						.where(eq(orders.id, update.orderId));
				}
			}

			// 9. Record executions
			for (const execution of matchResult.executions) {
				await tx.insert(executions).values({
					id: execution.id,
					marketId: execution.marketId,
					participants: JSON.stringify(execution.participants),
				});
			}

			return { executions: matchResult.executions };
		});
	});
}

// ============================================================================
// Resolution functions
// ============================================================================

export interface PayoutInfo {
	userId: string;
	shares: number;
	payout: number;
}

export interface ResolveMarketResult {
	market: MarketRecord;
	payouts: PayoutInfo[];
	totalPayout: number;
	winnerCount: number;
}

export async function resolveMarket(
	marketId: string,
	winningOutcomeId: string,
): Promise<ResolveMarketResult | null> {
	return withDbSpan("transaction", "markets", async () => {
		return db.transaction(async (tx) => {
			// 1. Verify outcome exists and belongs to market
			const [outcome] = await tx
				.select()
				.from(outcomes)
				.where(
					and(
						eq(outcomes.id, winningOutcomeId),
						eq(outcomes.marketId, marketId),
					),
				);

			if (!outcome) {
				return null;
			}

			// 2. Update market status (only if still open)
			const [updatedMarket] = await tx
				.update(markets)
				.set({
					status: "resolved",
					winningOutcomeId,
					resolvedAt: sql`now()`,
				})
				.where(and(eq(markets.id, marketId), eq(markets.status, "open")))
				.returning();

			if (!updatedMarket) {
				return null;
			}

			// 3. Cancel all outstanding orders and refund escrow
			const marketOrders = await tx
				.select()
				.from(orders)
				.where(eq(orders.marketId, marketId));

			for (const order of marketOrders) {
				await tx
					.update(users)
					.set({ locked: sql`${users.locked} - ${order.escrowAmount}` })
					.where(eq(users.discordId, order.userId));
			}

			await tx.delete(orders).where(eq(orders.marketId, marketId));

			// 4. Get all positions and calculate payouts
			const marketPositions = await tx
				.select()
				.from(positions)
				.where(eq(positions.marketId, marketId));

			const payouts: PayoutInfo[] = [];
			let totalPayout = 0;

			for (const position of marketPositions) {
				const holdings: Record<string, number> = JSON.parse(position.holdings);
				const payout = calculatePayout(holdings, winningOutcomeId);

				if (payout > 0) {
					payouts.push({
						userId: position.userId,
						shares: payout,
						payout,
					});
					totalPayout += payout;

					// Credit user balance
					await tx
						.insert(users)
						.values({ discordId: position.userId, balance: payout, locked: 0 })
						.onConflictDoUpdate({
							target: users.discordId,
							set: { balance: sql`${users.balance} + ${payout}` },
						});
				}
			}

			// 5. Delete all positions for this market
			await tx.delete(positions).where(eq(positions.marketId, marketId));

			return {
				market: updatedMarket,
				payouts,
				totalPayout,
				winnerCount: payouts.length,
			};
		});
	});
}
