import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("reactions-kalshi-bot", "1.0.0");

// === Reaction Metrics ===

export const reactionsAddedCounter = meter.createCounter(
	"reactions.added.total",
	{
		description: "Total number of reactions added",
		unit: "1",
	},
);

export const reactionsRemovedCounter = meter.createCounter(
	"reactions.removed.total",
	{
		description: "Total number of reactions removed",
		unit: "1",
	},
);

export const selfReactionsSkippedCounter = meter.createCounter(
	"reactions.self_skipped.total",
	{
		description: "Total number of self-reactions skipped",
		unit: "1",
	},
);

export const botReactionsSkippedCounter = meter.createCounter(
	"reactions.bot_skipped.total",
	{
		description: "Total number of bot message reactions skipped",
		unit: "1",
	},
);

export const reactionProcessingDuration = meter.createHistogram(
	"reactions.processing.duration",
	{
		description: "Time to process a reaction event",
		unit: "ms",
		advice: {
			explicitBucketBoundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
		},
	},
);

// === Command Metrics ===

export const commandInvocationsCounter = meter.createCounter(
	"commands.invocations.total",
	{
		description: "Total command invocations",
		unit: "1",
	},
);

export const commandErrorsCounter = meter.createCounter(
	"commands.errors.total",
	{
		description: "Total command errors",
		unit: "1",
	},
);

export const commandDuration = meter.createHistogram("commands.duration", {
	description: "Command execution duration",
	unit: "ms",
	advice: {
		explicitBucketBoundaries: [10, 50, 100, 250, 500, 1000, 2500, 5000],
	},
});

// === Database Metrics ===

export const dbQueryDuration = meter.createHistogram("db.query.duration", {
	description: "Database query execution duration",
	unit: "ms",
	advice: {
		explicitBucketBoundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
	},
});

export const dbQueryCounter = meter.createCounter("db.queries.total", {
	description: "Total database queries executed",
	unit: "1",
});

export const dbErrorsCounter = meter.createCounter("db.errors.total", {
	description: "Total database errors",
	unit: "1",
});

// === Backfill Metrics ===

export const backfillBatchCounter = meter.createCounter(
	"backfill.batches.total",
	{
		description: "Total backfill batch operations",
		unit: "1",
	},
);

export const backfillBatchDuration = meter.createHistogram(
	"backfill.batch.duration",
	{
		description: "Backfill batch processing duration",
		unit: "ms",
		advice: {
			explicitBucketBoundaries: [100, 500, 1000, 2500, 5000, 10000, 30000],
		},
	},
);

// Observable gauges for backfill progress - registered dynamically in backfill.ts
export { meter };

// === Leaderboard Metrics ===

export const leaderboardPageViewsCounter = meter.createCounter(
	"leaderboard.page_views.total",
	{
		description: "Total leaderboard page views",
		unit: "1",
	},
);

export const leaderboardQueryDuration = meter.createHistogram(
	"leaderboard.query.duration",
	{
		description: "Leaderboard query duration",
		unit: "ms",
		advice: {
			explicitBucketBoundaries: [5, 10, 25, 50, 100, 250, 500],
		},
	},
);
