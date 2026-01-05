import type { Market, Order, Outcome, Position } from "../../src/exchange.js";

export const sampleOutcomes: Outcome[] = [
	{ id: "outcome-yes", marketId: "market-1", number: 1, description: "Yes" },
	{ id: "outcome-no", marketId: "market-1", number: 2, description: "No" },
];

export const sampleMarket: Market = {
	id: "market-1",
	number: 1,
	guildId: "guild-123",
	creatorId: "creator-456",
	description: "Will it rain tomorrow?",
	oracle: { type: "manual", userId: "oracle-789" },
	outcomes: sampleOutcomes,
	status: "open",
};

export function createOrder(overrides: Partial<Order> = {}): Order {
	return {
		id: "order-1",
		userId: "user-1",
		marketId: "market-1",
		outcomeId: "outcome-yes",
		direction: "buy",
		quantity: 10,
		price: 0.5,
		escrowAmount: 5,
		...overrides,
	};
}

export function createPosition(overrides: Partial<Position> = {}): Position {
	return {
		userId: "user-1",
		marketId: "market-1",
		holdings: {},
		...overrides,
	};
}

export const outcomeIds = ["outcome-yes", "outcome-no"];
