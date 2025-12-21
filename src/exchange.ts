/**
 * P2P Prediction Market Exchange Engine
 *
 * Implements a zero-liquidity, peer-to-peer matching engine as specified in settlement.md.
 * Key features:
 * - Basket principle: complete set of outcomes always worth 1.0
 * - Direct matching: buyer and seller of same outcome
 * - Synthetic (triangle) matching: bids across outcomes sum to >= 1.0
 * - Pro-rata allocation when demand exceeds supply
 * - Surplus redistribution when triangle matches sum > 1.0
 */

// Types
export type Snowflake = string;
export type Direction = "buy" | "sell";

export interface Oracle {
	type: "manual" | "ai";
}

export interface ManualOracle extends Oracle {
	type: "manual";
	userId: Snowflake;
}

export interface Outcome {
	id: Snowflake;
	marketId: Snowflake;
	number: number;
	description: string;
}

export interface Market {
	id: Snowflake;
	number: number;
	guildId: Snowflake;
	creatorId: Snowflake;
	description: string;
	oracle: Oracle;
	outcomes: Outcome[];
	status: "open" | "resolved";
	winningOutcomeId?: Snowflake;
}

export interface Order {
	id: Snowflake;
	userId: Snowflake;
	marketId: Snowflake;
	outcomeId: Snowflake;
	direction: Direction;
	quantity: number;
	price: number;
	escrowAmount: number;
}

export interface Position {
	userId: Snowflake;
	marketId: Snowflake;
	holdings: Record<Snowflake, number>; // outcomeId -> quantity
}

export interface Party {
	userId: Snowflake;
	outcomeId: Snowflake;
	quantity: number;
	effectivePrice: number;
}

export interface Execution {
	id: Snowflake;
	marketId: Snowflake;
	timestamp: number;
	participants: Party[];
}

// ID Generation using Discord Snowflake-style format
let sequence = 0;
const EPOCH = 1704067200000; // Jan 1, 2024

export function generateId(): Snowflake {
	const timestamp = Date.now() - EPOCH;
	const seq = sequence++ % 4096;
	// Simplified snowflake: timestamp (42 bits) + sequence (12 bits)
	const id = (BigInt(timestamp) << 12n) | BigInt(seq);
	return id.toString();
}

/**
 * Calculate escrow required for an order.
 *
 * Buy orders: escrow = quantity * price
 * Sell orders: escrow = max(0, quantity - owned) * (1 - price)
 *   - If selling owned contracts, no additional escrow needed
 *   - If going short (selling more than owned), must cover potential loss
 */
export function calculateEscrow(
	direction: Direction,
	quantity: number,
	price: number,
	currentlyOwned: number,
): number {
	if (direction === "buy") {
		return quantity * price;
	}
	// Sell order: escrow the "mint gap" for short positions
	const shortQuantity = Math.max(0, quantity - currentlyOwned);
	return shortQuantity * (1 - price);
}

/**
 * Internal representation of an order with computed fields for matching
 */
interface OrderForMatching extends Order {
	remainingQuantity: number;
}

/**
 * Result of the matching algorithm
 */
interface MatchResult {
	executions: Execution[];
	orderUpdates: Array<{ orderId: Snowflake; newQuantity: number }>;
	positionUpdates: Array<{
		userId: Snowflake;
		outcomeId: Snowflake;
		quantityDelta: number;
	}>;
	balanceUpdates: Array<{
		userId: Snowflake;
		balanceDelta: number;
		lockedDelta: number;
	}>;
}

/**
 * Find the best synthetic (triangle) match across all outcomes.
 *
 * A synthetic match occurs when buy orders across different outcomes
 * sum to >= 1.0, allowing the exchange to "mint" a complete basket.
 */
function findSyntheticMatch(
	buyOrdersByOutcome: Map<Snowflake, OrderForMatching[]>,
	outcomeIds: Snowflake[],
): {
	matchQuantity: number;
	participants: Map<Snowflake, OrderForMatching[]>;
	totalPrice: number;
} | null {
	// Need at least one buy order per outcome for a complete basket
	for (const outcomeId of outcomeIds) {
		const orders = buyOrdersByOutcome.get(outcomeId);
		if (!orders || orders.length === 0) {
			return null;
		}
	}

	// Sort orders by price descending for each outcome
	for (const orders of buyOrdersByOutcome.values()) {
		orders.sort((a, b) => b.price - a.price);
	}

	// Check if the sum of best prices >= 1.0
	let totalBestPrice = 0;
	for (const outcomeId of outcomeIds) {
		const orders = buyOrdersByOutcome.get(outcomeId);
		if (orders && orders.length > 0) {
			totalBestPrice += orders[0].price;
		}
	}

	if (totalBestPrice < 1.0) {
		return null; // No synthetic match possible
	}

	// Find the maximum quantity we can match (limited by smallest order)
	let maxQuantity = Number.POSITIVE_INFINITY;
	const participants = new Map<Snowflake, OrderForMatching[]>();

	for (const outcomeId of outcomeIds) {
		const orders = buyOrdersByOutcome.get(outcomeId);
		if (orders && orders.length > 0) {
			// For now, use greedy approach: take best-priced order first
			const bestOrder = orders[0];
			maxQuantity = Math.min(maxQuantity, bestOrder.remainingQuantity);
			participants.set(outcomeId, [bestOrder]);
		}
	}

	if (maxQuantity === 0 || maxQuantity === Number.POSITIVE_INFINITY) {
		return null;
	}

	return {
		matchQuantity: maxQuantity,
		participants,
		totalPrice: totalBestPrice,
	};
}

/**
 * Main matching algorithm.
 *
 * 1. Collect all buy orders, grouped by outcome
 * 2. Find synthetic matches (bids sum to >= 1.0 across all outcomes)
 * 3. Calculate surplus and distribute pro-rata
 * 4. Update positions and balances
 */
export function executeMatching(
	orders: Order[],
	positions: Position[],
	outcomeIds: Snowflake[],
	marketId: Snowflake,
): MatchResult {
	const result: MatchResult = {
		executions: [],
		orderUpdates: [],
		positionUpdates: [],
		balanceUpdates: [],
	};

	// Convert orders to mutable format
	const ordersForMatching: OrderForMatching[] = orders.map((o) => ({
		...o,
		remainingQuantity: o.quantity,
	}));

	// Separate buy and sell orders by outcome
	const buyOrdersByOutcome = new Map<Snowflake, OrderForMatching[]>();
	const sellOrdersByOutcome = new Map<Snowflake, OrderForMatching[]>();

	for (const order of ordersForMatching) {
		const map =
			order.direction === "buy" ? buyOrdersByOutcome : sellOrdersByOutcome;
		if (!map.has(order.outcomeId)) {
			map.set(order.outcomeId, []);
		}
		map.get(order.outcomeId)?.push(order);
	}

	// Create position lookup
	const positionMap = new Map<string, Position>();
	for (const pos of positions) {
		positionMap.set(`${pos.userId}:${pos.marketId}`, pos);
	}

	// Track balance changes per user
	const userBalanceChanges = new Map<
		Snowflake,
		{ balanceDelta: number; lockedDelta: number }
	>();

	function updateUserBalance(
		userId: Snowflake,
		balanceDelta: number,
		lockedDelta: number,
	) {
		const existing = userBalanceChanges.get(userId) || {
			balanceDelta: 0,
			lockedDelta: 0,
		};
		existing.balanceDelta += balanceDelta;
		existing.lockedDelta += lockedDelta;
		userBalanceChanges.set(userId, existing);
	}

	// Keep matching until no more matches possible
	let matchFound = true;
	while (matchFound) {
		matchFound = false;

		// Try to find a synthetic match
		const syntheticMatch = findSyntheticMatch(buyOrdersByOutcome, outcomeIds);

		if (syntheticMatch) {
			matchFound = true;
			const { matchQuantity, participants, totalPrice } = syntheticMatch;

			// Calculate surplus to redistribute
			const surplus = totalPrice - 1.0;
			const surplusPerOutcome = surplus / outcomeIds.length;

			const executionParticipants: Party[] = [];

			// Process each participant in the match
			for (const [outcomeId, matchedOrders] of participants) {
				for (const order of matchedOrders) {
					// Calculate effective price after surplus redistribution
					const effectivePrice = order.price - surplusPerOutcome;

					// Calculate actual cost for this fill
					const fillCost = matchQuantity * effectivePrice;

					// The escrowed amount was at original price
					const escrowUsed = matchQuantity * order.price;
					const escrowRefund = escrowUsed - fillCost;

					// Update user balance: refund surplus from escrow
					updateUserBalance(order.userId, escrowRefund, -escrowUsed);

					// Decrement order quantity
					order.remainingQuantity -= matchQuantity;

					// Add position update
					result.positionUpdates.push({
						userId: order.userId,
						outcomeId,
						quantityDelta: matchQuantity,
					});

					// Add to execution participants
					executionParticipants.push({
						userId: order.userId,
						outcomeId,
						quantity: matchQuantity,
						effectivePrice,
					});
				}
			}

			// Create execution record
			result.executions.push({
				id: generateId(),
				marketId,
				timestamp: Date.now(),
				participants: executionParticipants,
			});

			// Clean up fully filled orders
			for (const outcomeId of outcomeIds) {
				const orders = buyOrdersByOutcome.get(outcomeId);
				if (orders) {
					const remaining = orders.filter((o) => o.remainingQuantity > 0);
					buyOrdersByOutcome.set(outcomeId, remaining);
				}
			}
		}

		// TODO: Add direct matching (Buy[A] + Sell[A])
		// For now, focus on synthetic matching as that's the core innovation
	}

	// Compile order updates
	for (const order of ordersForMatching) {
		if (order.remainingQuantity !== order.quantity) {
			result.orderUpdates.push({
				orderId: order.id,
				newQuantity: order.remainingQuantity,
			});
		}
	}

	// Compile balance updates
	for (const [userId, changes] of userBalanceChanges) {
		result.balanceUpdates.push({
			userId,
			balanceDelta: changes.balanceDelta,
			lockedDelta: changes.lockedDelta,
		});
	}

	return result;
}

/**
 * Validate an order before submission.
 */
export function validateOrder(
	direction: Direction,
	quantity: number,
	price: number,
): { valid: boolean; error?: string } {
	if (quantity <= 0 || !Number.isInteger(quantity)) {
		return { valid: false, error: "Quantity must be a positive integer" };
	}

	if (price <= 0 || price >= 1) {
		return { valid: false, error: "Price must be between 0 and 1 (exclusive)" };
	}

	return { valid: true };
}

/**
 * Calculate position value at resolution.
 *
 * When a market resolves, each unit of the winning outcome pays 1.0.
 * All other outcomes pay 0.
 */
export function calculatePayout(
	holdings: Record<Snowflake, number>,
	winningOutcomeId: Snowflake,
): number {
	return holdings[winningOutcomeId] || 0;
}
