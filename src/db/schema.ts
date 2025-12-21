import {
	integer,
	pgTable,
	real,
	serial,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";

// Users table with locked balance for escrow
export const users = pgTable("users", {
	discordId: text("discord_id").primaryKey(),
	balance: real("balance").notNull().default(0),
	locked: real("locked").notNull().default(0), // Escrowed funds
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

// Reactions table (unchanged - for the currency earning system)
export const reactions = pgTable(
	"reactions",
	{
		id: serial("id").primaryKey(),
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

// Backfill progress (unchanged)
export const backfillProgress = pgTable(
	"backfill_progress",
	{
		id: serial("id").primaryKey(),
		guildId: text("guild_id").notNull(),
		channelId: text("channel_id").notNull(),
		lastMessageId: text("last_message_id"),
		messagesProcessed: integer("messages_processed").notNull().default(0),
		reactionsAdded: integer("reactions_added").notNull().default(0),
		status: text("status").notNull().default("pending"),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => ({
		uniqueChannel: unique().on(table.guildId, table.channelId),
	}),
);

// Markets table - prediction markets
export const markets = pgTable("markets", {
	id: text("id").primaryKey(), // Snowflake ID
	number: serial("number"), // Auto-incrementing display number
	guildId: text("guild_id").notNull(),
	creatorId: text("creator_id").notNull(),
	description: text("description").notNull(),
	oracleType: text("oracle_type").notNull(), // 'manual' | 'ai'
	oracleUserId: text("oracle_user_id"), // For manual oracles
	status: text("status").notNull().default("open"), // 'open' | 'resolved'
	winningOutcomeId: text("winning_outcome_id"), // Set when resolved
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// Outcomes table - possible results for each market
export const outcomes = pgTable("outcomes", {
	id: text("id").primaryKey(), // Snowflake ID
	marketId: text("market_id")
		.notNull()
		.references(() => markets.id),
	number: integer("number").notNull(), // 1-indexed within market
	description: text("description").notNull(),
});

// Orders table - resting limit orders (one per user per market)
export const orders = pgTable(
	"orders",
	{
		id: text("id").primaryKey(), // Snowflake ID
		userId: text("user_id").notNull(),
		marketId: text("market_id")
			.notNull()
			.references(() => markets.id),
		outcomeId: text("outcome_id")
			.notNull()
			.references(() => outcomes.id),
		direction: text("direction").notNull(), // 'buy' | 'sell'
		quantity: integer("quantity").notNull(),
		price: real("price").notNull(), // 0 < price <= 1
		escrowAmount: real("escrow_amount").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => ({
		uniqueUserMarket: unique().on(table.userId, table.marketId),
	}),
);

// Positions table - user holdings in each market
export const positions = pgTable(
	"positions",
	{
		id: text("id").primaryKey(), // Snowflake ID
		userId: text("user_id").notNull(),
		marketId: text("market_id")
			.notNull()
			.references(() => markets.id),
		holdings: text("holdings").notNull().default("{}"), // JSON: Record<outcomeId, number>
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => ({
		uniqueUserMarket: unique().on(table.userId, table.marketId),
	}),
);

// Executions table - trade history with multi-party fills
export const executions = pgTable("executions", {
	id: text("id").primaryKey(), // Snowflake ID
	marketId: text("market_id")
		.notNull()
		.references(() => markets.id),
	timestamp: timestamp("timestamp", { withTimezone: true })
		.notNull()
		.defaultNow(),
	participants: text("participants").notNull(), // JSON: Party[]
});
