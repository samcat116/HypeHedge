import { describe, expect, it } from "vitest";
import {
	calculateEscrow,
	calculatePayout,
	executeMatching,
	generateId,
	validateOrder,
} from "../../src/exchange.js";
import { createOrder, outcomeIds } from "../fixtures/market.js";

describe("exchange", () => {
	describe("validateOrder", () => {
		it("should accept valid buy order", () => {
			const result = validateOrder("buy", 10, 0.5);
			expect(result).toEqual({ valid: true });
		});

		it("should accept valid sell order", () => {
			const result = validateOrder("sell", 5, 0.75);
			expect(result).toEqual({ valid: true });
		});

		it("should reject zero quantity", () => {
			const result = validateOrder("buy", 0, 0.5);
			expect(result.valid).toBe(false);
			expect(result.error).toContain("positive integer");
		});

		it("should reject negative quantity", () => {
			const result = validateOrder("buy", -5, 0.5);
			expect(result.valid).toBe(false);
			expect(result.error).toContain("positive integer");
		});

		it("should reject non-integer quantity", () => {
			const result = validateOrder("buy", 5.5, 0.5);
			expect(result.valid).toBe(false);
			expect(result.error).toContain("positive integer");
		});

		it("should reject price at 0", () => {
			const result = validateOrder("buy", 10, 0);
			expect(result.valid).toBe(false);
			expect(result.error).toContain("between 0 and 1");
		});

		it("should reject price at 1", () => {
			const result = validateOrder("buy", 10, 1);
			expect(result.valid).toBe(false);
			expect(result.error).toContain("between 0 and 1");
		});

		it("should reject price above 1", () => {
			const result = validateOrder("buy", 10, 1.5);
			expect(result.valid).toBe(false);
			expect(result.error).toContain("between 0 and 1");
		});

		it("should reject negative price", () => {
			const result = validateOrder("buy", 10, -0.5);
			expect(result.valid).toBe(false);
			expect(result.error).toContain("between 0 and 1");
		});

		it("should accept edge case prices near boundaries", () => {
			expect(validateOrder("buy", 10, 0.01)).toEqual({ valid: true });
			expect(validateOrder("buy", 10, 0.99)).toEqual({ valid: true });
		});
	});

	describe("calculateEscrow", () => {
		describe("buy orders", () => {
			it("should escrow quantity * price for buys", () => {
				expect(calculateEscrow("buy", 10, 0.5, 0)).toBe(5);
			});

			it("should ignore currently owned for buys", () => {
				expect(calculateEscrow("buy", 10, 0.5, 100)).toBe(5);
			});

			it("should handle low prices", () => {
				expect(calculateEscrow("buy", 100, 0.01, 0)).toBeCloseTo(1);
			});

			it("should handle high prices", () => {
				expect(calculateEscrow("buy", 100, 0.99, 0)).toBeCloseTo(99);
			});
		});

		describe("sell orders", () => {
			it("should escrow nothing when selling all owned contracts", () => {
				expect(calculateEscrow("sell", 10, 0.7, 10)).toBe(0);
			});

			it("should escrow nothing when selling less than owned", () => {
				expect(calculateEscrow("sell", 10, 0.7, 20)).toBe(0);
			});

			it("should escrow (1-price) * quantity for full short positions", () => {
				// Selling 10 with 0 owned = 10 short at 0.7 price
				// Escrow = 10 * (1 - 0.7) = 3
				expect(calculateEscrow("sell", 10, 0.7, 0)).toBeCloseTo(3);
			});

			it("should escrow partial short when partially owned", () => {
				// Selling 10, own 4 = 6 short
				// Escrow = 6 * (1 - 0.5) = 3
				expect(calculateEscrow("sell", 10, 0.5, 4)).toBe(3);
			});

			it("should handle high sell price (low escrow for shorts)", () => {
				// Selling 10 at 0.9 price, own 0 = escrow 10 * 0.1 = 1
				expect(calculateEscrow("sell", 10, 0.9, 0)).toBeCloseTo(1);
			});

			it("should handle low sell price (high escrow for shorts)", () => {
				// Selling 10 at 0.1 price, own 0 = escrow 10 * 0.9 = 9
				expect(calculateEscrow("sell", 10, 0.1, 0)).toBeCloseTo(9);
			});
		});
	});

	describe("calculatePayout", () => {
		it("should return holdings of winning outcome", () => {
			const holdings = { "outcome-yes": 10, "outcome-no": 5 };
			expect(calculatePayout(holdings, "outcome-yes")).toBe(10);
		});

		it("should return 0 for non-winning outcomes", () => {
			const holdings = { "outcome-yes": 10, "outcome-no": 5 };
			expect(calculatePayout(holdings, "outcome-other")).toBe(0);
		});

		it("should return 0 for empty holdings", () => {
			expect(calculatePayout({}, "outcome-yes")).toBe(0);
		});

		it("should handle negative holdings (short positions)", () => {
			const holdings = { "outcome-yes": -5 };
			expect(calculatePayout(holdings, "outcome-yes")).toBe(-5);
		});
	});

	describe("generateId", () => {
		it("should generate unique IDs", () => {
			const ids = new Set<string>();
			for (let i = 0; i < 100; i++) {
				ids.add(generateId());
			}
			expect(ids.size).toBe(100);
		});

		it("should generate string IDs", () => {
			const id = generateId();
			expect(typeof id).toBe("string");
			expect(id.length).toBeGreaterThan(0);
		});

		it("should generate numeric string IDs", () => {
			const id = generateId();
			expect(/^\d+$/.test(id)).toBe(true);
		});
	});

	describe("executeMatching", () => {
		const marketId = "market-1";

		describe("direct matching", () => {
			it("should match crossing buy and sell orders on same outcome", () => {
				const orders = [
					createOrder({
						id: "order-buy",
						userId: "buyer",
						outcomeId: "outcome-yes",
						direction: "buy",
						quantity: 10,
						price: 0.6,
						escrowAmount: 6,
					}),
					createOrder({
						id: "order-sell",
						userId: "seller",
						outcomeId: "outcome-yes",
						direction: "sell",
						quantity: 10,
						price: 0.4,
						escrowAmount: 6,
					}),
				];

				const result = executeMatching(orders, [], outcomeIds, marketId);

				expect(result.executions).toHaveLength(1);
				expect(result.executions[0].participants).toHaveLength(2);

				// Buyer gains contracts
				expect(result.positionUpdates).toContainEqual(
					expect.objectContaining({
						userId: "buyer",
						outcomeId: "outcome-yes",
						quantityDelta: 10,
					}),
				);

				// Seller loses contracts
				expect(result.positionUpdates).toContainEqual(
					expect.objectContaining({
						userId: "seller",
						outcomeId: "outcome-yes",
						quantityDelta: -10,
					}),
				);
			});

			it("should not match when prices do not cross", () => {
				const orders = [
					createOrder({
						id: "order-buy",
						userId: "buyer",
						outcomeId: "outcome-yes",
						direction: "buy",
						quantity: 10,
						price: 0.4, // Buyer willing to pay 0.4
						escrowAmount: 4,
					}),
					createOrder({
						id: "order-sell",
						userId: "seller",
						outcomeId: "outcome-yes",
						direction: "sell",
						quantity: 10,
						price: 0.6, // Seller wants 0.6
						escrowAmount: 4,
					}),
				];

				const result = executeMatching(orders, [], outcomeIds, marketId);

				expect(result.executions).toHaveLength(0);
				expect(result.positionUpdates).toHaveLength(0);
			});

			it("should partially fill when quantities differ", () => {
				const orders = [
					createOrder({
						id: "order-buy",
						userId: "buyer",
						outcomeId: "outcome-yes",
						direction: "buy",
						quantity: 10,
						price: 0.6,
						escrowAmount: 6,
					}),
					createOrder({
						id: "order-sell",
						userId: "seller",
						outcomeId: "outcome-yes",
						direction: "sell",
						quantity: 5, // Only selling 5
						price: 0.4,
						escrowAmount: 3,
					}),
				];

				const result = executeMatching(orders, [], outcomeIds, marketId);

				expect(result.executions).toHaveLength(1);

				// Buyer order should have 5 remaining
				expect(result.orderUpdates).toContainEqual({
					orderId: "order-buy",
					newQuantity: 5,
				});

				// Seller order fully filled
				expect(result.orderUpdates).toContainEqual({
					orderId: "order-sell",
					newQuantity: 0,
				});
			});

			it("should match at midpoint price", () => {
				const orders = [
					createOrder({
						id: "order-buy",
						userId: "buyer",
						outcomeId: "outcome-yes",
						direction: "buy",
						quantity: 10,
						price: 0.7,
						escrowAmount: 7,
					}),
					createOrder({
						id: "order-sell",
						userId: "seller",
						outcomeId: "outcome-yes",
						direction: "sell",
						quantity: 10,
						price: 0.3,
						escrowAmount: 7,
					}),
				];

				const result = executeMatching(orders, [], outcomeIds, marketId);

				expect(result.executions).toHaveLength(1);
				// Midpoint = (0.7 + 0.3) / 2 = 0.5
				expect(result.executions[0].participants[0].effectivePrice).toBe(0.5);
			});
		});

		describe("synthetic matching", () => {
			it("should match when bids across outcomes sum to >= 1.0", () => {
				const orders = [
					createOrder({
						id: "order-yes",
						userId: "user-yes",
						outcomeId: "outcome-yes",
						direction: "buy",
						quantity: 10,
						price: 0.6,
						escrowAmount: 6,
					}),
					createOrder({
						id: "order-no",
						userId: "user-no",
						outcomeId: "outcome-no",
						direction: "buy",
						quantity: 10,
						price: 0.5,
						escrowAmount: 5,
					}),
				];

				const result = executeMatching(orders, [], outcomeIds, marketId);

				// 0.6 + 0.5 = 1.1 >= 1.0, should match
				expect(result.executions).toHaveLength(1);
				expect(result.positionUpdates.length).toBeGreaterThan(0);
			});

			it("should not match when bids sum to < 1.0", () => {
				const orders = [
					createOrder({
						id: "order-yes",
						userId: "user-yes",
						outcomeId: "outcome-yes",
						direction: "buy",
						quantity: 10,
						price: 0.4,
						escrowAmount: 4,
					}),
					createOrder({
						id: "order-no",
						userId: "user-no",
						outcomeId: "outcome-no",
						direction: "buy",
						quantity: 10,
						price: 0.4,
						escrowAmount: 4,
					}),
				];

				const result = executeMatching(orders, [], outcomeIds, marketId);

				// 0.4 + 0.4 = 0.8 < 1.0, should not match
				expect(result.executions).toHaveLength(0);
			});

			it("should fill minimum quantity across outcomes", () => {
				const orders = [
					createOrder({
						id: "order-yes",
						userId: "user-yes",
						outcomeId: "outcome-yes",
						direction: "buy",
						quantity: 10,
						price: 0.6,
						escrowAmount: 6,
					}),
					createOrder({
						id: "order-no",
						userId: "user-no",
						outcomeId: "outcome-no",
						direction: "buy",
						quantity: 5, // Smaller quantity
						price: 0.5,
						escrowAmount: 2.5,
					}),
				];

				const result = executeMatching(orders, [], outcomeIds, marketId);

				expect(result.executions).toHaveLength(1);

				// Should fill at 5 (minimum of 10 and 5)
				expect(result.orderUpdates).toContainEqual({
					orderId: "order-yes",
					newQuantity: 5, // 10 - 5 = 5 remaining
				});
				expect(result.orderUpdates).toContainEqual({
					orderId: "order-no",
					newQuantity: 0, // Fully filled
				});
			});
		});

		describe("no orders", () => {
			it("should return empty results with no orders", () => {
				const result = executeMatching([], [], outcomeIds, marketId);

				expect(result.executions).toHaveLength(0);
				expect(result.orderUpdates).toHaveLength(0);
				expect(result.positionUpdates).toHaveLength(0);
				expect(result.balanceUpdates).toHaveLength(0);
			});
		});

		describe("balance updates", () => {
			it("should update balances for direct matches", () => {
				const orders = [
					createOrder({
						id: "order-buy",
						userId: "buyer",
						outcomeId: "outcome-yes",
						direction: "buy",
						quantity: 10,
						price: 0.5,
						escrowAmount: 5,
					}),
					createOrder({
						id: "order-sell",
						userId: "seller",
						outcomeId: "outcome-yes",
						direction: "sell",
						quantity: 10,
						price: 0.5,
						escrowAmount: 5,
					}),
				];

				const result = executeMatching(orders, [], outcomeIds, marketId);

				expect(result.balanceUpdates.length).toBeGreaterThan(0);

				// Find buyer and seller balance updates
				const buyerUpdate = result.balanceUpdates.find(
					(u) => u.userId === "buyer",
				);
				const sellerUpdate = result.balanceUpdates.find(
					(u) => u.userId === "seller",
				);

				expect(buyerUpdate).toBeDefined();
				expect(sellerUpdate).toBeDefined();

				// Locked amounts should decrease (escrow released)
				expect(buyerUpdate?.lockedDelta).toBeLessThan(0);
				expect(sellerUpdate?.lockedDelta).toBeLessThan(0);
			});
		});
	});
});
