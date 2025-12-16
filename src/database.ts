import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "./db";
import { backfillProgress, reactions, users } from "./db/schema";
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
