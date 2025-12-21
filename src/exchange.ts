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
 * Find the best synthetic (triangle) match from any subset of outcomes.
 *
 * A synthetic match occurs when buy orders across ANY subset of outcomes
 * sum to >= 1.0, allowing the exchange to "mint" a complete basket.
 * Surplus contracts from the mint are distributed to participants pro-rata.
 *
 * Algorithm:
 * 1. Get best bid for each outcome that has orders
 * 2. Sort outcomes by best bid price descending
 * 3. Greedily add outcomes until sum >= 1.0
 * 4. Return the matching subset with surplus info
 */
function findSyntheticMatch(
	buyOrdersByOutcome: Map<Snowflake, OrderForMatching[]>,
	outcomeIds: Snowflake[],
): {
	matchQuantity: number;
	participants: Map<Snowflake, OrderForMatching[]>;
	participatingOutcomeIds: Snowflake[];
	totalPrice: number;
} | null {
	// Sort orders by price descending for each outcome
	for (const orders of buyOrdersByOutcome.values()) {
		orders.sort((a, b) => b.price - a.price);
	}

	// Get best bid for each outcome that has orders
	const outcomesWithBids: Array<{
		outcomeId: Snowflake;
		bestOrder: OrderForMatching;
		price: number;
	}> = [];

	for (const outcomeId of outcomeIds) {
		const orders = buyOrdersByOutcome.get(outcomeId);
		if (orders && orders.length > 0) {
			outcomesWithBids.push({
				outcomeId,
				bestOrder: orders[0],
				price: orders[0].price,
			});
		}
	}

	if (outcomesWithBids.length === 0) {
		return null;
	}

	// Sort by price descending to greedily select highest-value bids first
	outcomesWithBids.sort((a, b) => b.price - a.price);

	// Greedily add outcomes until we reach >= 1.0
	let totalPrice = 0;
	const selectedOutcomes: typeof outcomesWithBids = [];

	for (const outcome of outcomesWithBids) {
		selectedOutcomes.push(outcome);
		totalPrice += outcome.price;

		if (totalPrice >= 1.0) {
			break;
		}
	}

	// Check if we found a valid match
	if (totalPrice < 1.0) {
		return null; // No synthetic match possible
	}

	// Find the maximum quantity we can match (limited by smallest order)
	let maxQuantity = Number.POSITIVE_INFINITY;
	const participants = new Map<Snowflake, OrderForMatching[]>();
	const participatingOutcomeIds: Snowflake[] = [];

	for (const { outcomeId, bestOrder } of selectedOutcomes) {
		maxQuantity = Math.min(maxQuantity, bestOrder.remainingQuantity);
		participants.set(outcomeId, [bestOrder]);
		participatingOutcomeIds.push(outcomeId);
	}

	if (maxQuantity === 0 || maxQuantity === Number.POSITIVE_INFINITY) {
		return null;
	}

	return {
		matchQuantity: maxQuantity,
		participants,
		participatingOutcomeIds,
		totalPrice,
	};
}

/**
 * Find the best direct match for a specific outcome.
 *
 * A direct match occurs when a buy order and sell order for the same outcome
 * have crossing prices (buy price >= sell price). The buyer purchases existing
 * contracts from the seller.
 */
function findDirectMatch(
	buyOrders: OrderForMatching[],
	sellOrders: OrderForMatching[],
): {
	buyOrder: OrderForMatching;
	sellOrder: OrderForMatching;
	matchQuantity: number;
	matchPrice: number;
} | null {
	if (buyOrders.length === 0 || sellOrders.length === 0) {
		return null;
	}

	// Sort buys by price descending (highest bid first)
	buyOrders.sort((a, b) => b.price - a.price);
	// Sort sells by price ascending (lowest ask first)
	sellOrders.sort((a, b) => a.price - b.price);

	const bestBuy = buyOrders[0];
	const bestSell = sellOrders[0];

	// Check if prices cross (buyer willing to pay >= seller's ask)
	if (bestBuy.price < bestSell.price) {
		return null; // No match possible
	}

	// Match at midpoint price (fair split of surplus)
	const matchPrice = (bestBuy.price + bestSell.price) / 2;
	const matchQuantity = Math.min(
		bestBuy.remainingQuantity,
		bestSell.remainingQuantity,
	);

	if (matchQuantity === 0) {
		return null;
	}

	return {
		buyOrder: bestBuy,
		sellOrder: bestSell,
		matchQuantity,
		matchPrice,
	};
}

/**
 * Main matching algorithm.
 *
 * 1. Collect all buy orders, grouped by outcome
 * 2. Find direct matches (Buy[A] + Sell[A] where prices cross)
 * 3. Find synthetic matches (bids sum to >= 1.0 across outcomes)
 * 4. Calculate surplus and distribute pro-rata
 * 5. Update positions and balances
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
			const {
				matchQuantity,
				participants,
				participatingOutcomeIds,
				totalPrice,
			} = syntheticMatch;

			// Calculate total contribution for pro-rata distribution of surplus contracts
			let totalContribution = 0;
			for (const [, matchedOrders] of participants) {
				for (const order of matchedOrders) {
					totalContribution += order.price;
				}
			}

			const executionParticipants: Party[] = [];

			// Non-participating outcomes (outcomes not in this match) will have
			// surplus contracts minted and distributed pro-rata to participants
			const nonParticipatingOutcomeIds = outcomeIds.filter(
				(id) => !participatingOutcomeIds.includes(id),
			);

			// Process each participant in the match
			for (const [outcomeId, matchedOrders] of participants) {
				for (const order of matchedOrders) {
					// Each participant pays their bid price
					const fillCost = matchQuantity * order.price;

					// The escrowed amount was at original price
					const escrowUsed = matchQuantity * order.price;

					// Update user balance:
					// - Deduct the fill cost from balance (actual payment)
					// - Release the escrow (reduce locked amount)
					updateUserBalance(order.userId, -fillCost, -escrowUsed);

					// Decrement order quantity
					order.remainingQuantity -= matchQuantity;

					// Add position update for the outcome they bid on
					result.positionUpdates.push({
						userId: order.userId,
						outcomeId,
						quantityDelta: matchQuantity,
					});

					// Calculate pro-rata share of surplus contracts for non-participating outcomes
					// Their share is proportional to their contribution (price * quantity)
					const contributionShare = order.price / totalContribution;

					// Distribute surplus contracts for outcomes not in the match
					// When we mint a basket, we get 1 contract for EACH outcome
					// Participants only want their specific outcome, so the others are surplus
					for (const surplusOutcomeId of nonParticipatingOutcomeIds) {
						const surplusQuantity = matchQuantity * contributionShare;
						if (surplusQuantity > 0) {
							result.positionUpdates.push({
								userId: order.userId,
								outcomeId: surplusOutcomeId,
								quantityDelta: surplusQuantity,
							});
						}
					}

					// Calculate effective price (what they actually paid per contract of their outcome)
					// They paid order.price but also received surplus contracts worth something
					const effectivePrice = order.price;

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

			// Clean up fully filled orders from participating outcomes only
			for (const outcomeId of participatingOutcomeIds) {
				const orders = buyOrdersByOutcome.get(outcomeId);
				if (orders) {
					const remaining = orders.filter((o) => o.remainingQuantity > 0);
					buyOrdersByOutcome.set(outcomeId, remaining);
				}
			}
		}

		// Try to find direct matches (Buy[A] + Sell[A])
		for (const outcomeId of outcomeIds) {
			const buyOrders = buyOrdersByOutcome.get(outcomeId) || [];
			const sellOrders = sellOrdersByOutcome.get(outcomeId) || [];

			const directMatch = findDirectMatch(buyOrders, sellOrders);

			if (directMatch) {
				matchFound = true;
				const { buyOrder, sellOrder, matchQuantity, matchPrice } = directMatch;

				// Buyer pays matchPrice per contract
				const buyerCost = matchQuantity * matchPrice;
				// Buyer had escrowed at their bid price
				const buyerEscrowUsed =
					(matchQuantity / buyOrder.quantity) * buyOrder.escrowAmount;
				// Buyer gets refund if they escrowed more than needed
				const buyerRefund = buyerEscrowUsed - buyerCost;

				// Update buyer balance:
				// - Deduct the actual cost from balance
				// - Release their escrow
				// - Add back any refund (if bid was higher than match price)
				updateUserBalance(
					buyOrder.userId,
					-buyerCost + buyerRefund,
					-buyerEscrowUsed,
				);

				// Seller receives matchPrice per contract
				const sellerProceeds = matchQuantity * matchPrice;
				// Seller had escrowed for short position (if any)
				const sellerEscrowUsed =
					(matchQuantity / sellOrder.quantity) * sellOrder.escrowAmount;

				// Update seller balance:
				// - Add the proceeds to balance
				// - Release their escrow
				updateUserBalance(
					sellOrder.userId,
					sellerProceeds + sellerEscrowUsed,
					-sellerEscrowUsed,
				);

				// Decrement order quantities
				buyOrder.remainingQuantity -= matchQuantity;
				sellOrder.remainingQuantity -= matchQuantity;

				// Position updates:
				// Buyer gains contracts
				result.positionUpdates.push({
					userId: buyOrder.userId,
					outcomeId,
					quantityDelta: matchQuantity,
				});
				// Seller loses contracts (or goes short)
				result.positionUpdates.push({
					userId: sellOrder.userId,
					outcomeId,
					quantityDelta: -matchQuantity,
				});

				// Create execution record
				result.executions.push({
					id: generateId(),
					marketId,
					timestamp: Date.now(),
					participants: [
						{
							userId: buyOrder.userId,
							outcomeId,
							quantity: matchQuantity,
							effectivePrice: matchPrice,
						},
						{
							userId: sellOrder.userId,
							outcomeId,
							quantity: -matchQuantity,
							effectivePrice: matchPrice,
						},
					],
				});

				// Clean up fully filled orders
				if (buyOrder.remainingQuantity === 0) {
					const orders = buyOrdersByOutcome.get(outcomeId);
					if (orders) {
						buyOrdersByOutcome.set(
							outcomeId,
							orders.filter((o) => o.id !== buyOrder.id),
						);
					}
				}
				if (sellOrder.remainingQuantity === 0) {
					const orders = sellOrdersByOutcome.get(outcomeId);
					if (orders) {
						sellOrdersByOutcome.set(
							outcomeId,
							orders.filter((o) => o.id !== sellOrder.id),
						);
					}
				}

				// Break to restart the matching loop (prioritize direct matches)
				break;
			}
		}
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
