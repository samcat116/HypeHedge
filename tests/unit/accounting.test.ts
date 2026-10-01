import { describe, expect, it } from "vitest";
import {
	allocateUnits,
	coinsToUnits,
	contractsToShareUnits,
	formatUnits,
	multiplySharesByPrice,
	parseHoldings,
	parsePriceToUnits,
	prorateShareUnits,
} from "../../src/accounting.js";
import {
	type Order,
	type Position,
	executeMatching,
	validateOrder,
} from "../../src/exchange.js";

function order(
	id: string,
	outcomeId: string,
	quantityUnits: number,
	priceUnits: number,
	direction: "buy" | "sell" = "buy",
): Order {
	return {
		id,
		userId: id,
		marketId: "market",
		outcomeId,
		quantityUnits,
		priceUnits,
		direction,
		escrowUnits:
			direction === "buy"
				? multiplySharesByPrice(quantityUnits, priceUnits, "ceil")
				: 0,
	};
}

function owned(orders: Order[]): Position[] {
	return orders
		.filter((value) => value.direction === "sell")
		.map((value) => ({
			userId: value.userId,
			marketId: value.marketId,
			holdings: { [value.outcomeId]: value.quantityUnits },
		}));
}

describe("fixed accounting invariants", () => {
	it("uses exact intermediate products even above Number.MAX_SAFE_INTEGER", () => {
		const shares = Number.MAX_SAFE_INTEGER;
		expect(multiplySharesByPrice(shares, 9999, "floor")).toBe(
			Number((BigInt(shares) * 9999n) / 10000n),
		);
		expect(prorateShareUnits(shares, 17, 19, "ceil")).toBe(
			Number((BigInt(shares) * 17n + 18n) / 19n),
		);
	});

	it("rejects unsafe, fractional, and nonfinite values", () => {
		for (const value of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			1.1,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expect(() => multiplySharesByPrice(value, 5000)).toThrow();
			expect(validateOrder("buy", value, 5000).valid).toBe(false);
			expect(validateOrder("buy", 10000, value).valid).toBe(false);
		}
		expect(() => contractsToShareUnits(Number.MAX_SAFE_INTEGER)).toThrow();
		expect(() => coinsToUnits(Number.POSITIVE_INFINITY)).toThrow();
		expect(() => prorateShareUnits(1, 1, 0)).toThrow();
	});

	it("formats units exactly through the supported range", () => {
		expect(formatUnits(Number.MAX_SAFE_INTEGER)).toBe("900719925474.0991");
		expect(formatUnits(-1)).toBe("-0.0001");
		expect(formatUnits(10100)).toBe("1.01");
	});

	it("accepts cent prices and rejects greater precision", () => {
		expect(parsePriceToUnits(0.29)).toBe(2900);
		for (const value of [0, 1, Number.NaN, Number.POSITIVE_INFINITY, 0.295])
			expect(parsePriceToUnits(value)).toBeNull();
	});

	it("allocates each unit exactly once with stable remainder ties", () => {
		expect(allocateUnits(1, [1, 1, 1])).toEqual([1, 0, 0]);
		for (let total = 0; total < 100; total++) {
			const allocation = allocateUnits(total, [7, 5, 3]);
			expect(allocation.reduce((sum, value) => sum + value, 0)).toBe(total);
			expect(allocation.every(Number.isSafeInteger)).toBe(true);
		}
	});

	it("never releases negative escrow across repeated tiny partial fills", () => {
		const buyer = order("buyer", "yes", 10, 6000);
		const sellers = Array.from({ length: 10 }, (_, i) =>
			order(`seller${i}`, "yes", 1, 4000, "sell"),
		);
		const result = executeMatching(
			[buyer, ...sellers],
			owned(sellers),
			["yes", "no"],
			"market",
		);
		expect(
			result.balanceUpdates.find((value) => value.userId === "buyer")
				?.lockedUnitsDelta,
		).toBe(-6);
		expect(
			result.orderUpdates.every((value) => value.newEscrowUnits >= 0),
		).toBe(true);
		expect(
			result.balanceUpdates.reduce(
				(sum, value) => sum + value.balanceUnitsDelta,
				0,
			),
		).toBe(0);
	});

	it("retains conservative escrow when a partial order is executed again", () => {
		const first = executeMatching(
			[
				order("buyer", "yes", 10, 6000),
				order("seller", "yes", 1, 4000, "sell"),
			],
			[
				{ userId: "seller", marketId: "market", holdings: { yes: 1 } },
				{ userId: "seller2", marketId: "market", holdings: { yes: 9 } },
			],
			["yes", "no"],
			"market",
		);
		const update = first.orderUpdates.find(
			(value) => value.orderId === "buyer",
		);
		expect(update).toEqual({
			orderId: "buyer",
			newQuantityUnits: 9,
			newEscrowUnits: 6,
		});
		const second = executeMatching(
			[
				{
					...order("buyer", "yes", 9, 6000),
					escrowUnits: update?.newEscrowUnits ?? 0,
				},
				order("seller2", "yes", 9, 4000, "sell"),
			],
			[
				{ userId: "seller", marketId: "market", holdings: { yes: 1 } },
				{ userId: "seller2", marketId: "market", holdings: { yes: 9 } },
			],
			["yes", "no"],
			"market",
		);
		expect(
			second.balanceUpdates.find((value) => value.userId === "buyer")
				?.lockedUnitsDelta,
		).toBe(-6);
	});

	it("returns synthetic price surplus and conserves every minted outcome", () => {
		const result = executeMatching(
			[order("a", "yes", 10001, 6000), order("b", "no", 10001, 6000)],
			[],
			["yes", "no", "other"],
			"market",
		);
		expect(
			result.balanceUpdates.reduce(
				(sum, value) => sum - value.balanceUnitsDelta,
				0,
			),
		).toBe(10001);
		for (const outcome of ["yes", "no", "other"]) {
			expect(
				result.positionUpdates
					.filter((value) => value.outcomeId === outcome)
					.reduce((sum, value) => sum + value.quantityUnitsDelta, 0),
			).toBe(10001);
		}
		expect(
			result.balanceUpdates.every(
				(value) => -value.balanceUnitsDelta <= -value.lockedUnitsDelta,
			),
		).toBe(true);
	});

	it("leaves a synthetic fill resting when rounding cannot preserve remaining collateral", () => {
		const result = executeMatching(
			[
				order("a", "yes", 2000, 3400),
				order("b", "no", 2000, 3300),
				order("c", "other", 3, 3300),
			],
			[],
			["yes", "no", "other"],
			"market",
		);
		expect(result.executions).toHaveLength(0);
	});
	it("rejects malformed, negative, or unsafe active holdings", () => {
		for (const json of [
			"null",
			"[]",
			'{"yes":-1}',
			'{"yes":1.5}',
			'{"yes":9007199254740992}',
		])
			expect(() => parseHoldings(json)).toThrow();
		expect(parseHoldings('{"yes":12345}')).toEqual({ yes: 12345 });
	});
});
