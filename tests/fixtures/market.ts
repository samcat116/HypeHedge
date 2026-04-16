import {
	coinsToUnits,
	contractsToShareUnits,
	multiplySharesByPrice,
	parsePriceToUnits,
} from "../../src/accounting.js";
import type { Market, Order, Outcome, Position } from "../../src/exchange.js";

export function price(value: number): number {
	const priceUnits = parsePriceToUnits(value);
	if (priceUnits === null) {
		throw new Error(`Invalid fixture price: ${value}`);
	}
	return priceUnits;
}

export function quantity(value: number): number {
	return contractsToShareUnits(value);
}

export function escrow(quantityUnits: number, priceUnits: number): number {
	return multiplySharesByPrice(quantityUnits, priceUnits);
}

type OrderOverrides = Partial<Order> & {
	quantity?: number;
	price?: number;
	escrow?: number;
};

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

export function createOrder(overrides: OrderOverrides = {}): Order {
	const {
		quantity: quantityContracts = 10,
		price: priceDecimal = 0.5,
		escrow: escrowCoins,
		...orderOverrides
	} = overrides;
	const quantityUnits = quantity(quantityContracts);
	const priceUnits = price(priceDecimal);

	return {
		id: "order-1",
		userId: "user-1",
		marketId: "market-1",
		outcomeId: "outcome-yes",
		direction: "buy",
		quantityUnits,
		priceUnits,
		escrowUnits:
			escrowCoins === undefined
				? escrow(quantityUnits, priceUnits)
				: coinsToUnits(escrowCoins),
		...orderOverrides,
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
