import {
	bigint,
	bigserial,
	integer,
	pgTable,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";

export const markets = pgTable("markets", {
	id: bigserial("id", { mode: "number" }).primaryKey(),
	guildId: text("guild_id").notNull(),
	creatorId: text("creator_id").notNull(),
	oracleId: text("oracle_id").notNull(),
	description: text("description").notNull(),
	outcomeType: text("outcome_type").notNull(), // "binary" | "multi"
	options: text("options").array(), // null for binary, ["Option A", "Option B", ...] for multi
	status: text("status").notNull().default("open"), // "open" | "resolved"
	resolution: text("resolution"), // null until resolved
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const backfillProgress = pgTable(
	"backfill_progress",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		guildId: text("guild_id").notNull(),
		channelId: text("channel_id").notNull(),
		lastMessageId: text("last_message_id"), // null = not started, stores Discord snowflake for pagination
		messagesProcessed: integer("messages_processed").notNull().default(0),
		reactionsAdded: integer("reactions_added").notNull().default(0),
		status: text("status").notNull().default("pending"), // pending | in_progress | completed
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => ({
		uniqueChannel: unique().on(table.guildId, table.channelId),
	}),
);

export const users = pgTable("users", {
	discordId: text("discord_id").primaryKey(),
	balance: integer("balance").notNull().default(0),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const reactions = pgTable(
	"reactions",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		messageId: text("message_id").notNull(),
		reactorId: text("reactor_id").notNull(),
		authorId: text("author_id").notNull(),
		emoji: text("emoji").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => ({
		uniqueReaction: unique().on(table.messageId, table.reactorId, table.emoji),
	}),
);

export const marketPools = pgTable("market_pools", {
	id: bigserial("id", { mode: "number" }).primaryKey(),
	marketId: bigint("market_id", { mode: "number" })
		.notNull()
		.references(() => markets.id)
		.unique(),
	liquidity: integer("liquidity").notNull().default(100),
	outcomeShares: text("outcome_shares").notNull(), // JSON: {"Yes": 0, "No": 0}
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const positions = pgTable(
	"positions",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		marketId: bigint("market_id", { mode: "number" })
			.notNull()
			.references(() => markets.id),
		userId: text("user_id").notNull(),
		outcome: text("outcome").notNull(), // "Yes"/"No" or option name
		shares: integer("shares").notNull().default(0),
		avgCostBasis: integer("avg_cost_basis").notNull().default(0), // Average price paid per share
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => ({
		uniquePosition: unique().on(table.marketId, table.userId, table.outcome),
	}),
);

export const trades = pgTable("trades", {
	id: bigserial("id", { mode: "number" }).primaryKey(),
	marketId: bigint("market_id", { mode: "number" })
		.notNull()
		.references(() => markets.id),
	userId: text("user_id").notNull(),
	outcome: text("outcome").notNull(),
	tradeType: text("trade_type").notNull(), // "buy" | "sell"
	shares: integer("shares").notNull(),
	price: integer("price").notNull(), // Total cost/proceeds
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});
