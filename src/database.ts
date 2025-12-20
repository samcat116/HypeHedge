import { and, desc, eq, gt, gte, lt, sql } from "drizzle-orm";
import {
	type PoolState,
	calculateBuyCost,
	calculateSellProceeds,
	getAllPrices,
	getPrice,
	initializePool,
	parsePoolState,
	serializeOutcomeShares,
} from "./amm.js";
import { db } from "./db";
import {
	backfillProgress,
	marketPools,
	markets,
	positions,
	reactions,
	trades,
	users,
} from "./db/schema";
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
					.values({ discordId: authorId, balance: 1 })
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

export async function getBalance(userId: string): Promise<number> {
	return withDbSpan("select", "users", async () => {
		const [user] = await db
			.select({ balance: users.balance })
			.from(users)
			.where(eq(users.discordId, userId));

		return user?.balance ?? 0;
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

		return results.map((r, i) => ({ ...r, rank: i + 1 }));
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
			rank: offset + i + 1,
		}));

		return {
			entries,
			totalCount,
			hasMore: offset + entries.length < totalCount,
		};
	});
}

// Backfill progress functions

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
					.values({ discordId: authorId, balance: count })
					.onConflictDoUpdate({
						target: users.discordId,
						set: { balance: sql`${users.balance} + ${count}` },
					});
			}
		});

		return inserted.length;
	});
}

// Market functions

export type MarketRecord = typeof markets.$inferSelect;

export interface CreateMarketParams {
	guildId: string;
	creatorId: string;
	oracleId: string;
	description: string;
	outcomeType: "binary" | "multi";
	options?: string[];
}

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

export async function createMarket(
	params: CreateMarketParams,
): Promise<MarketRecord> {
	return withDbSpan("insert", "markets", async () => {
		const [market] = await db
			.insert(markets)
			.values({
				guildId: params.guildId,
				creatorId: params.creatorId,
				oracleId: params.oracleId,
				description: params.description,
				outcomeType: params.outcomeType,
				options: params.options ?? null,
			})
			.returning();

		// Create AMM pool for the market
		const outcomes =
			params.outcomeType === "binary" ? ["Yes", "No"] : (params.options ?? []);
		const pool = initializePool(outcomes);

		await db.insert(marketPools).values({
			marketId: market.id,
			liquidity: pool.liquidity,
			outcomeShares: serializeOutcomeShares(pool.outcomeShares),
		});

		return market;
	});
}

export async function getMarket(id: number): Promise<MarketRecord | null> {
	return withDbSpan("select", "markets", async () => {
		const [market] = await db.select().from(markets).where(eq(markets.id, id));

		return market ?? null;
	});
}

export async function getGuildMarkets(
	guildId: string,
	status?: "open" | "resolved",
): Promise<MarketRecord[]> {
	return withDbSpan("select", "markets", async () => {
		const conditions = [eq(markets.guildId, guildId)];
		if (status) {
			conditions.push(eq(markets.status, status));
		}

		return db
			.select()
			.from(markets)
			.where(and(...conditions))
			.orderBy(desc(markets.createdAt));
	});
}

export interface PaginatedMarkets {
	markets: MarketRecord[];
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

		const [results, countResult] = await Promise.all([
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

		return {
			markets: results,
			totalCount,
			hasMore: offset + results.length < totalCount,
		};
	});
}

export async function getOracleOpenMarkets(
	guildId: string,
	oracleId: string,
): Promise<MarketRecord[]> {
	return withDbSpan("select", "markets", async () => {
		return db
			.select()
			.from(markets)
			.where(
				and(
					eq(markets.guildId, guildId),
					eq(markets.oracleId, oracleId),
					eq(markets.status, "open"),
				),
			)
			.orderBy(desc(markets.createdAt));
	});
}

export async function resolveMarket(
	marketId: number,
	resolution: string,
): Promise<ResolveMarketResult | null> {
	return withDbSpan("transaction", "markets", async () => {
		return db.transaction(async (tx) => {
			// 1. Update market status (only if still open to prevent double-resolution)
			const [updatedMarket] = await tx
				.update(markets)
				.set({
					status: "resolved",
					resolution,
					resolvedAt: sql`now()`,
				})
				.where(and(eq(markets.id, marketId), eq(markets.status, "open")))
				.returning();

			if (!updatedMarket) {
				return null;
			}

			// 2. Get all winning positions (shares of the winning outcome)
			const winningPositions = await tx
				.select({
					userId: positions.userId,
					shares: positions.shares,
				})
				.from(positions)
				.where(
					and(
						eq(positions.marketId, marketId),
						eq(positions.outcome, resolution),
						gt(positions.shares, 0),
					),
				);

			// 3. Calculate and process payouts (1 coin per share)
			const payouts: PayoutInfo[] = [];
			let totalPayout = 0;

			for (const position of winningPositions) {
				const payout = position.shares; // 1 coin per share
				payouts.push({
					userId: position.userId,
					shares: position.shares,
					payout,
				});
				totalPayout += payout;

				// Credit user balance
				await tx
					.insert(users)
					.values({ discordId: position.userId, balance: payout })
					.onConflictDoUpdate({
						target: users.discordId,
						set: { balance: sql`${users.balance} + ${payout}` },
					});
			}

			return {
				market: updatedMarket,
				payouts,
				totalPayout,
				winnerCount: payouts.length,
			};
		});
	});
}

// Pool management functions

export type MarketPoolRecord = typeof marketPools.$inferSelect;

export async function getMarketPool(
	marketId: number,
): Promise<MarketPoolRecord | null> {
	return withDbSpan("select", "market_pools", async () => {
		const [pool] = await db
			.select()
			.from(marketPools)
			.where(eq(marketPools.marketId, marketId));

		return pool ?? null;
	});
}

export async function getMarketPrices(
	marketId: number,
): Promise<Record<string, number> | null> {
	const pool = await getMarketPool(marketId);
	if (!pool) return null;

	const poolState = parsePoolState(pool.outcomeShares, pool.liquidity);
	return getAllPrices(poolState);
}

// Trading functions

export interface TradeResult {
	success: boolean;
	shares: number;
	cost: number;
	newPrice: number;
	error?: string;
}

export async function buyShares(
	marketId: number,
	userId: string,
	outcome: string,
	shares: number,
): Promise<TradeResult> {
	return withDbSpan("transaction", "positions", async () => {
		return db.transaction(async (tx) => {
			// 1. Get market and verify it's open
			const [market] = await tx
				.select()
				.from(markets)
				.where(eq(markets.id, marketId));

			if (!market || market.status !== "open") {
				return {
					success: false,
					shares: 0,
					cost: 0,
					newPrice: 0,
					error: "Market not open",
				};
			}

			// 2. Get pool state
			const [pool] = await tx
				.select()
				.from(marketPools)
				.where(eq(marketPools.marketId, marketId));

			if (!pool) {
				return {
					success: false,
					shares: 0,
					cost: 0,
					newPrice: 0,
					error: "Pool not found",
				};
			}

			const poolState = parsePoolState(pool.outcomeShares, pool.liquidity);

			// Validate outcome exists
			if (!(outcome in poolState.outcomeShares)) {
				return {
					success: false,
					shares: 0,
					cost: 0,
					newPrice: 0,
					error: "Invalid outcome",
				};
			}

			// 3. Calculate cost
			const cost = calculateBuyCost(poolState, outcome, shares);

			// 4. Check user balance
			const [user] = await tx
				.select({ balance: users.balance })
				.from(users)
				.where(eq(users.discordId, userId));

			const balance = user?.balance ?? 0;
			if (balance < cost) {
				return {
					success: false,
					shares: 0,
					cost: 0,
					newPrice: 0,
					error: `Insufficient balance. Need ${cost}, have ${balance}`,
				};
			}

			// 5. Deduct user balance
			await tx
				.update(users)
				.set({ balance: sql`${users.balance} - ${cost}` })
				.where(eq(users.discordId, userId));

			// 6. Update pool state
			poolState.outcomeShares[outcome] += shares;
			await tx
				.update(marketPools)
				.set({
					outcomeShares: serializeOutcomeShares(poolState.outcomeShares),
					updatedAt: sql`now()`,
				})
				.where(eq(marketPools.marketId, marketId));

			// 7. Upsert position
			const [existingPosition] = await tx
				.select()
				.from(positions)
				.where(
					and(
						eq(positions.marketId, marketId),
						eq(positions.userId, userId),
						eq(positions.outcome, outcome),
					),
				);

			if (existingPosition) {
				// Update with weighted average cost basis
				const totalShares = existingPosition.shares + shares;
				const totalCost =
					existingPosition.avgCostBasis * existingPosition.shares + cost;
				const newAvgCostBasis = Math.ceil(totalCost / totalShares);

				await tx
					.update(positions)
					.set({
						shares: totalShares,
						avgCostBasis: newAvgCostBasis,
						updatedAt: sql`now()`,
					})
					.where(eq(positions.id, existingPosition.id));
			} else {
				await tx.insert(positions).values({
					marketId,
					userId,
					outcome,
					shares,
					avgCostBasis: Math.ceil(cost / shares),
				});
			}

			// 8. Record trade
			await tx.insert(trades).values({
				marketId,
				userId,
				outcome,
				tradeType: "buy",
				shares,
				price: cost,
			});

			const newPrice = getPrice(poolState, outcome);

			return { success: true, shares, cost, newPrice };
		});
	});
}

export async function sellShares(
	marketId: number,
	userId: string,
	outcome: string,
	shares: number,
): Promise<TradeResult> {
	return withDbSpan("transaction", "positions", async () => {
		return db.transaction(async (tx) => {
			// 1. Verify market is open
			const [market] = await tx
				.select()
				.from(markets)
				.where(eq(markets.id, marketId));

			if (!market || market.status !== "open") {
				return {
					success: false,
					shares: 0,
					cost: 0,
					newPrice: 0,
					error: "Market not open",
				};
			}

			// 2. Get user's position
			const [position] = await tx
				.select()
				.from(positions)
				.where(
					and(
						eq(positions.marketId, marketId),
						eq(positions.userId, userId),
						eq(positions.outcome, outcome),
					),
				);

			if (!position || position.shares < shares) {
				return {
					success: false,
					shares: 0,
					cost: 0,
					newPrice: 0,
					error: `Insufficient shares. Have ${position?.shares ?? 0}`,
				};
			}

			// 3. Get pool and calculate proceeds
			const [pool] = await tx
				.select()
				.from(marketPools)
				.where(eq(marketPools.marketId, marketId));

			if (!pool) {
				return {
					success: false,
					shares: 0,
					cost: 0,
					newPrice: 0,
					error: "Pool not found",
				};
			}

			const poolState = parsePoolState(pool.outcomeShares, pool.liquidity);
			const proceeds = calculateSellProceeds(poolState, outcome, shares);

			// 4. Update pool state
			poolState.outcomeShares[outcome] -= shares;
			await tx
				.update(marketPools)
				.set({
					outcomeShares: serializeOutcomeShares(poolState.outcomeShares),
					updatedAt: sql`now()`,
				})
				.where(eq(marketPools.marketId, marketId));

			// 5. Update position
			const newShares = position.shares - shares;
			if (newShares === 0) {
				await tx.delete(positions).where(eq(positions.id, position.id));
			} else {
				await tx
					.update(positions)
					.set({ shares: newShares, updatedAt: sql`now()` })
					.where(eq(positions.id, position.id));
			}

			// 6. Credit user balance
			await tx
				.insert(users)
				.values({ discordId: userId, balance: proceeds })
				.onConflictDoUpdate({
					target: users.discordId,
					set: { balance: sql`${users.balance} + ${proceeds}` },
				});

			// 7. Record trade
			await tx.insert(trades).values({
				marketId,
				userId,
				outcome,
				tradeType: "sell",
				shares,
				price: proceeds,
			});

			const newPrice = getPrice(poolState, outcome);

			return { success: true, shares, cost: proceeds, newPrice };
		});
	});
}

// Position query functions

export interface UserPosition {
	marketId: number;
	marketDescription: string;
	marketStatus: string;
	outcome: string;
	shares: number;
	avgCostBasis: number;
	currentPrice: number;
}

export async function getUserPositions(
	userId: string,
	guildId?: string,
): Promise<UserPosition[]> {
	return withDbSpan("select", "positions", async () => {
		const conditions = [eq(positions.userId, userId)];
		if (guildId) {
			conditions.push(eq(markets.guildId, guildId));
		}

		const userPositions = await db
			.select({
				marketId: positions.marketId,
				outcome: positions.outcome,
				shares: positions.shares,
				avgCostBasis: positions.avgCostBasis,
				marketDescription: markets.description,
				marketStatus: markets.status,
				guildId: markets.guildId,
			})
			.from(positions)
			.innerJoin(markets, eq(positions.marketId, markets.id))
			.where(and(...conditions));

		// Get current prices for each market
		const result: UserPosition[] = [];
		for (const pos of userPositions) {
			const pool = await getMarketPool(pos.marketId);
			if (pool) {
				const poolState = parsePoolState(pool.outcomeShares, pool.liquidity);
				const currentPrice = getPrice(poolState, pos.outcome);
				result.push({
					marketId: pos.marketId,
					marketDescription: pos.marketDescription,
					marketStatus: pos.marketStatus,
					outcome: pos.outcome,
					shares: pos.shares,
					avgCostBasis: pos.avgCostBasis,
					currentPrice: Math.round(currentPrice * 100), // Convert to percentage
				});
			}
		}

		return result;
	});
}

export async function getGuildOpenMarkets(
	guildId: string,
): Promise<MarketRecord[]> {
	return withDbSpan("select", "markets", async () => {
		return db
			.select()
			.from(markets)
			.where(and(eq(markets.guildId, guildId), eq(markets.status, "open")))
			.orderBy(desc(markets.createdAt));
	});
}
