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

import {
	PRICE_SCALE,
	type PriceUnits,
	type ShareUnits,
	type UnitAmount,
	addUnits,
	allocateUnits,
	multiplySharesByPrice,
	prorateShareUnits,
} from "./accounting.js";

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
	quantityUnits: ShareUnits;
	priceUnits: PriceUnits;
	escrowUnits: UnitAmount;
}

export interface Position {
	userId: Snowflake;
	marketId: Snowflake;
	holdings: Record<Snowflake, ShareUnits>; // outcomeId -> scaled contract units
}

export interface Party {
	userId: Snowflake;
	outcomeId: Snowflake;
	quantityUnits: ShareUnits;
	effectivePriceUnits: PriceUnits;
	/** Exact cash delta for new executions; legacy records may omit it. */
	balanceUnitsDelta?: UnitAmount;
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
	quantityUnits: ShareUnits,
	priceUnits: PriceUnits,
	currentlyOwnedUnits: ShareUnits,
): UnitAmount {
	if (direction === "buy") {
		return multiplySharesByPrice(quantityUnits, priceUnits, "ceil");
	}
	// Sell order: escrow the "mint gap" for short positions
	const shortQuantityUnits = Math.max(0, quantityUnits - currentlyOwnedUnits);
	return multiplySharesByPrice(
		shortQuantityUnits,
		PRICE_SCALE - priceUnits,
		"ceil",
	);
}

/**
 * Internal representation of an order with computed fields for matching
 */
interface OrderForMatching extends Order {
	remainingQuantityUnits: ShareUnits;
	remainingEscrowUnits: UnitAmount;
}

/**
 * Result of the matching algorithm
 */
interface MatchResult {
	executions: Execution[];
	orderUpdates: Array<{
		orderId: Snowflake;
		newQuantityUnits: ShareUnits;
		newEscrowUnits: UnitAmount;
	}>;
	positionUpdates: Array<{
		userId: Snowflake;
		outcomeId: Snowflake;
		quantityUnitsDelta: ShareUnits;
	}>;
	balanceUpdates: Array<{
		userId: Snowflake;
		balanceUnitsDelta: UnitAmount;
		lockedUnitsDelta: UnitAmount;
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
	matchQuantityUnits: ShareUnits;
	participants: Map<Snowflake, OrderForMatching[]>;
	participatingOutcomeIds: Snowflake[];
	totalPriceUnits: PriceUnits;
	contributions: UnitAmount[];
} | null {
	// Sort orders by price descending for each outcome
	for (const orders of buyOrdersByOutcome.values()) {
		orders.sort((a, b) => b.priceUnits - a.priceUnits);
	}

	// Get best bid for each outcome that has orders
	const outcomesWithBids: Array<{
		outcomeId: Snowflake;
		bestOrder: OrderForMatching;
		priceUnits: PriceUnits;
	}> = [];

	for (const outcomeId of outcomeIds) {
		const orders = buyOrdersByOutcome.get(outcomeId);
		if (orders && orders.length > 0) {
			outcomesWithBids.push({
				outcomeId,
				bestOrder: orders[0],
				priceUnits: orders[0].priceUnits,
			});
		}
	}

	if (outcomesWithBids.length === 0) {
		return null;
	}

	// Sort by price descending to greedily select highest-value bids first
	outcomesWithBids.sort((a, b) => b.priceUnits - a.priceUnits);

	// Greedily add outcomes until we reach >= 1.0
	let totalPriceUnits = 0;
	const selectedOutcomes: typeof outcomesWithBids = [];

	for (const outcome of outcomesWithBids) {
		selectedOutcomes.push(outcome);
		totalPriceUnits += outcome.priceUnits;

		if (totalPriceUnits >= PRICE_SCALE) {
			break;
		}
	}

	// Check if we found a valid match
	if (totalPriceUnits < PRICE_SCALE) {
		return null; // No synthetic match possible
	}

	// Find the maximum quantity we can match (limited by smallest order)
	let maxQuantityUnits = Number.POSITIVE_INFINITY;
	const participants = new Map<Snowflake, OrderForMatching[]>();
	const participatingOutcomeIds: Snowflake[] = [];

	for (const { outcomeId, bestOrder } of selectedOutcomes) {
		maxQuantityUnits = Math.min(
			maxQuantityUnits,
			bestOrder.remainingQuantityUnits,
		);
		participants.set(outcomeId, [bestOrder]);
		participatingOutcomeIds.push(outcomeId);
	}

	if (maxQuantityUnits === 0 || maxQuantityUnits === Number.POSITIVE_INFINITY) {
		return null;
	}

	const matched = [...participants.values()].flat();
	const capacities = matched.map((order) =>
		Math.min(
			escrowForFill(order, maxQuantityUnits),
			multiplySharesByPrice(maxQuantityUnits, order.priceUnits, "ceil"),
		),
	);
	// A sub-unit fill can require more currency than can be released while
	// retaining collateral for remaining orders. Leave it on the book.
	if (capacities.reduce((sum, value) => sum + value, 0) < maxQuantityUnits)
		return null;
	const contributions = allocateUnits(
		maxQuantityUnits,
		matched.map((order) => order.priceUnits),
	);
	let excess = 0;
	for (let i = 0; i < contributions.length; i++) {
		if (contributions[i] > capacities[i]) {
			excess += contributions[i] - capacities[i];
			contributions[i] = capacities[i];
		}
	}
	for (let i = 0; i < contributions.length && excess > 0; i++) {
		const amount = Math.min(excess, capacities[i] - contributions[i]);
		contributions[i] += amount;
		excess -= amount;
	}

	return {
		matchQuantityUnits: maxQuantityUnits,
		participants,
		participatingOutcomeIds,
		totalPriceUnits,
		contributions,
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
	matchQuantityUnits: ShareUnits;
	matchPriceUnits: PriceUnits;
} | null {
	if (buyOrders.length === 0 || sellOrders.length === 0) {
		return null;
	}

	// Sort buys by price descending (highest bid first)
	buyOrders.sort((a, b) => b.priceUnits - a.priceUnits);
	// Sort sells by price ascending (lowest ask first)
	sellOrders.sort((a, b) => a.priceUnits - b.priceUnits);

	const bestBuy = buyOrders[0];
	const bestSell = sellOrders[0];

	// Check if prices cross (buyer willing to pay >= seller's ask)
	if (bestBuy.priceUnits < bestSell.priceUnits) {
		return null; // No match possible
	}

	// Match at midpoint price (fair split of surplus)
	const matchPriceUnits = Math.round(
		(bestBuy.priceUnits + bestSell.priceUnits) / 2,
	);
	const matchQuantityUnits = Math.min(
		bestBuy.remainingQuantityUnits,
		bestSell.remainingQuantityUnits,
	);

	if (matchQuantityUnits === 0) {
		return null;
	}

	return {
		buyOrder: bestBuy,
		sellOrder: bestSell,
		matchQuantityUnits,
		matchPriceUnits,
	};
}

/**
 * Consume remaining order escrow proportionally to the fill quantity.
 *
 * The final fill consumes every leftover escrow unit so rounding never leaves
 * stale locked funds attached to a fully filled order.
 */
function escrowForFill(
	order: OrderForMatching,
	fillQuantityUnits: ShareUnits,
): UnitAmount {
	const remaining = order.remainingQuantityUnits - fillQuantityUnits;
	const reserved =
		remaining <= 0
			? 0
			: prorateShareUnits(
					order.escrowUnits,
					remaining,
					order.quantityUnits,
					"ceil",
				);
	return order.remainingEscrowUnits - reserved;
}

function consumeEscrow(
	order: OrderForMatching,
	fillQuantityUnits: ShareUnits,
): UnitAmount {
	const escrowUnits = escrowForFill(order, fillQuantityUnits);
	order.remainingEscrowUnits -= escrowUnits;
	return escrowUnits;
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

	const holdings = new Map<Snowflake, Record<Snowflake, ShareUnits>>();
	for (const position of positions) {
		for (const amount of Object.values(position.holdings)) {
			if (!Number.isSafeInteger(amount) || amount < 0)
				throw new Error(
					"Legacy short or unsafe holdings require reconciliation",
				);
		}
		holdings.set(position.userId, { ...position.holdings });
	}
	function updatePosition(
		userId: Snowflake,
		outcomeId: Snowflake,
		delta: ShareUnits,
	) {
		const current = holdings.get(userId) ?? {};
		current[outcomeId] = addUnits(current[outcomeId] ?? 0, delta);
		if (!Number.isSafeInteger(current[outcomeId]) || current[outcomeId] < 0)
			throw new Error("Invalid position update");
		holdings.set(userId, current);
		if (delta !== 0)
			result.positionUpdates.push({
				userId,
				outcomeId,
				quantityUnitsDelta: delta,
			});
	}

	// Convert orders to mutable format
	const ordersForMatching: OrderForMatching[] = orders.map((o) => ({
		...o,
		remainingQuantityUnits: o.quantityUnits,
		remainingEscrowUnits: o.escrowUnits,
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

	// Track balance changes per user
	const userBalanceChanges = new Map<
		Snowflake,
		{ balanceUnitsDelta: UnitAmount; lockedUnitsDelta: UnitAmount }
	>();

	function updateUserBalance(
		userId: Snowflake,
		balanceUnitsDelta: UnitAmount,
		lockedUnitsDelta: UnitAmount,
	) {
		const existing = userBalanceChanges.get(userId) || {
			balanceUnitsDelta: 0,
			lockedUnitsDelta: 0,
		};
		existing.balanceUnitsDelta = addUnits(
			existing.balanceUnitsDelta,
			balanceUnitsDelta,
		);
		existing.lockedUnitsDelta = addUnits(
			existing.lockedUnitsDelta,
			lockedUnitsDelta,
		);
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
			const { matchQuantityUnits, participants, participatingOutcomeIds } =
				syntheticMatch;

			const matched = [...participants.values()].flat();
			const weights = matched.map((order) => order.priceUnits);
			const contributions = syntheticMatch.contributions;
			const surplusShares = allocateUnits(matchQuantityUnits, weights);
			let participantIndex = 0;

			const executionParticipants: Party[] = [];

			// Non-participating outcomes (outcomes not in this match) will have
			// surplus contracts minted and distributed pro-rata to participants
			const nonParticipatingOutcomeIds = outcomeIds.filter(
				(id) => !participatingOutcomeIds.includes(id),
			);

			// Process each participant in the match
			for (const [outcomeId, matchedOrders] of participants) {
				for (const order of matchedOrders) {
					// Each participant funds their pro-rata share of the basket cost
					const fillCostUnits = contributions[participantIndex];

					// The escrowed amount was at original price
					const escrowUsedUnits = consumeEscrow(order, matchQuantityUnits);

					// Update user balance:
					// - Deduct the fill cost from balance (actual payment)
					// - Release the escrow (reduce locked amount)
					updateUserBalance(order.userId, -fillCostUnits, -escrowUsedUnits);

					// Decrement order quantity
					order.remainingQuantityUnits -= matchQuantityUnits;

					// Add position update for the outcome they bid on
					updatePosition(order.userId, outcomeId, matchQuantityUnits);

					// Calculate pro-rata share of surplus contracts for non-participating outcomes
					// Their share is proportional to their contribution (price * quantity)
					// Distribute surplus contracts for outcomes not in the match
					// When we mint a basket, we get 1 contract for EACH outcome
					// Participants only want their specific outcome, so the others are surplus
					for (const surplusOutcomeId of nonParticipatingOutcomeIds) {
						const surplusQuantityUnits = surplusShares[participantIndex];
						if (surplusQuantityUnits > 0) {
							updatePosition(
								order.userId,
								surplusOutcomeId,
								surplusQuantityUnits,
							);
						}
					}

					// Calculate effective price (what they actually paid per contract of their outcome)
					// Cash allocation is exact; displayed price is rounded to a price unit
					const effectivePriceUnits = prorateShareUnits(
						fillCostUnits,
						PRICE_SCALE,
						matchQuantityUnits,
					);
					participantIndex += 1;

					// Add to execution participants
					executionParticipants.push({
						userId: order.userId,
						outcomeId,
						quantityUnits: matchQuantityUnits,
						effectivePriceUnits,
						balanceUnitsDelta: -fillCostUnits,
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
					const remaining = orders.filter((o) => o.remainingQuantityUnits > 0);
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
				const { buyOrder, sellOrder, matchQuantityUnits, matchPriceUnits } =
					directMatch;

				// Buyer pays matchPrice per contract
				const buyerCostUnits = multiplySharesByPrice(
					matchQuantityUnits,
					matchPriceUnits,
					"floor",
				);
				// Buyer had escrowed at their bid price
				const buyerEscrowUsedUnits = consumeEscrow(
					buyOrder,
					matchQuantityUnits,
				);

				if (buyerCostUnits > buyerEscrowUsedUnits)
					throw new Error("Buyer escrow is insufficient for the fill");

				// Update buyer balance:
				// - Deduct the actual cost from balance
				// - Release their escrow
				updateUserBalance(
					buyOrder.userId,
					-buyerCostUnits,
					-buyerEscrowUsedUnits,
				);

				const ownedUnits = Math.max(
					0,
					holdings.get(sellOrder.userId)?.[outcomeId] ?? 0,
				);
				const ownedFillUnits = Math.min(ownedUnits, matchQuantityUnits);
				const shortFillUnits = matchQuantityUnits - ownedFillUnits;
				// The seller funds a complete basket for each short contract and
				// transfers this outcome to the buyer, retaining all other outcomes.
				// Buyer and seller together pay exactly one unit per minted share.
				const sellerBalanceDelta = buyerCostUnits - shortFillUnits;
				const sellerRemainingQuantity =
					sellOrder.remainingQuantityUnits - matchQuantityUnits;
				const sellerReserved = calculateEscrow(
					"sell",
					sellerRemainingQuantity,
					sellOrder.priceUnits,
					ownedUnits - ownedFillUnits,
				);
				const sellerEscrowUsedUnits =
					sellOrder.remainingEscrowUnits - sellerReserved;
				if (sellerEscrowUsedUnits < Math.max(0, -sellerBalanceDelta))
					throw new Error("Seller escrow is insufficient for the short fill");
				sellOrder.remainingEscrowUnits = sellerReserved;
				updateUserBalance(
					sellOrder.userId,
					sellerBalanceDelta,
					-sellerEscrowUsedUnits,
				);

				buyOrder.remainingQuantityUnits -= matchQuantityUnits;
				sellOrder.remainingQuantityUnits = sellerRemainingQuantity;
				updatePosition(buyOrder.userId, outcomeId, matchQuantityUnits);
				updatePosition(sellOrder.userId, outcomeId, -ownedFillUnits);
				for (const otherOutcomeId of outcomeIds) {
					if (otherOutcomeId !== outcomeId)
						updatePosition(sellOrder.userId, otherOutcomeId, shortFillUnits);
				}

				// Create execution record
				result.executions.push({
					id: generateId(),
					marketId,
					timestamp: Date.now(),
					participants: [
						{
							userId: buyOrder.userId,
							outcomeId,
							quantityUnits: matchQuantityUnits,
							effectivePriceUnits: matchPriceUnits,
							balanceUnitsDelta: -buyerCostUnits,
						},
						{
							userId: sellOrder.userId,
							outcomeId,
							quantityUnits: -matchQuantityUnits,
							effectivePriceUnits: matchPriceUnits,
							balanceUnitsDelta: sellerBalanceDelta,
						},
					],
				});

				// Clean up fully filled orders
				if (buyOrder.remainingQuantityUnits === 0) {
					const orders = buyOrdersByOutcome.get(outcomeId);
					if (orders) {
						buyOrdersByOutcome.set(
							outcomeId,
							orders.filter((o) => o.id !== buyOrder.id),
						);
					}
				}
				if (sellOrder.remainingQuantityUnits === 0) {
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
		if (order.remainingQuantityUnits !== order.quantityUnits) {
			result.orderUpdates.push({
				orderId: order.id,
				newQuantityUnits: order.remainingQuantityUnits,
				newEscrowUnits: order.remainingEscrowUnits,
			});
		}
	}

	// Compile balance updates
	for (const [userId, changes] of userBalanceChanges) {
		result.balanceUpdates.push({
			userId,
			balanceUnitsDelta: changes.balanceUnitsDelta,
			lockedUnitsDelta: changes.lockedUnitsDelta,
		});
	}

	return result;
}

/**
 * Validate an order before submission.
 */
export function validateOrder(
	direction: Direction,
	quantityUnits: ShareUnits,
	priceUnits: PriceUnits,
): { valid: boolean; error?: string } {
	if (direction !== "buy" && direction !== "sell") {
		return { valid: false, error: "Direction must be buy or sell" };
	}

	if (quantityUnits <= 0 || !Number.isSafeInteger(quantityUnits)) {
		return { valid: false, error: "Quantity must be a positive integer" };
	}

	if (
		!Number.isSafeInteger(priceUnits) ||
		priceUnits <= 0 ||
		priceUnits >= PRICE_SCALE
	) {
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
	holdings: Record<Snowflake, ShareUnits>,
	winningOutcomeId: Snowflake,
): UnitAmount {
	return holdings[winningOutcomeId] || 0;
}
