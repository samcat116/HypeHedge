/**
 * LMSR (Logarithmic Market Scoring Rule) Automated Market Maker
 *
 * Provides dynamic pricing for prediction markets where prices reflect
 * the probability of each outcome and adjust based on trading activity.
 */

export interface PoolState {
	liquidity: number; // b parameter - higher = more stable prices
	outcomeShares: Record<string, number>; // Outstanding shares per outcome
}

/**
 * Cost function: C(q) = b * ln(sum(e^(q_i/b)))
 * Returns the total cost to reach the current state
 */
function costFunction(pool: PoolState): number {
	const b = pool.liquidity;
	const sum = Object.values(pool.outcomeShares).reduce(
		(acc, q) => acc + Math.exp(q / b),
		0,
	);
	return b * Math.log(sum);
}

/**
 * Get current price for an outcome (0 to 1, representing probability)
 * Price formula: price_i = e^(q_i/b) / sum(e^(q_j/b))
 */
export function getPrice(pool: PoolState, outcome: string): number {
	const b = pool.liquidity;
	const shares = pool.outcomeShares;

	if (!(outcome in shares)) {
		throw new Error(`Invalid outcome: ${outcome}`);
	}

	const expSum = Object.values(shares).reduce(
		(acc, q) => acc + Math.exp(q / b),
		0,
	);
	const outcomeExp = Math.exp(shares[outcome] / b);

	return outcomeExp / expSum;
}

/**
 * Get prices for all outcomes
 * Returns a record mapping outcome names to prices (0-1)
 */
export function getAllPrices(pool: PoolState): Record<string, number> {
	const prices: Record<string, number> = {};
	for (const outcome of Object.keys(pool.outcomeShares)) {
		prices[outcome] = getPrice(pool, outcome);
	}
	return prices;
}

/**
 * Calculate cost to buy N shares of an outcome
 * Cost = C(new state) - C(current state)
 * Rounds up to prevent rounding exploits
 */
export function calculateBuyCost(
	pool: PoolState,
	outcome: string,
	shares: number,
): number {
	if (shares <= 0) {
		throw new Error("Shares must be positive");
	}

	if (!(outcome in pool.outcomeShares)) {
		throw new Error(`Invalid outcome: ${outcome}`);
	}

	const currentCost = costFunction(pool);

	const newShares = { ...pool.outcomeShares };
	newShares[outcome] += shares;

	const newCost = costFunction({ ...pool, outcomeShares: newShares });

	// Round up for buys to prevent rounding exploits
	return Math.ceil(newCost - currentCost);
}

/**
 * Calculate proceeds from selling N shares of an outcome
 * Proceeds = C(current state) - C(new state)
 * Rounds down to prevent rounding exploits
 */
export function calculateSellProceeds(
	pool: PoolState,
	outcome: string,
	shares: number,
): number {
	if (shares <= 0) {
		throw new Error("Shares must be positive");
	}

	if (!(outcome in pool.outcomeShares)) {
		throw new Error(`Invalid outcome: ${outcome}`);
	}

	const currentCost = costFunction(pool);

	const newShares = { ...pool.outcomeShares };
	newShares[outcome] -= shares;

	const newCost = costFunction({ ...pool, outcomeShares: newShares });

	// Round down for sells to prevent rounding exploits
	return Math.floor(currentCost - newCost);
}

/**
 * Initialize a pool for a new market
 * All outcomes start with 0 outstanding shares, giving equal initial prices
 */
export function initializePool(outcomes: string[], liquidity = 100): PoolState {
	if (outcomes.length < 2) {
		throw new Error("Markets require at least 2 outcomes");
	}

	const outcomeShares: Record<string, number> = {};
	for (const outcome of outcomes) {
		outcomeShares[outcome] = 0; // Start with 0 outstanding shares = equal prices
	}

	return { liquidity, outcomeShares };
}

/**
 * Parse pool state from JSON string (for database retrieval)
 */
export function parsePoolState(
	outcomeSharesJson: string,
	liquidity: number,
): PoolState {
	return {
		liquidity,
		outcomeShares: JSON.parse(outcomeSharesJson) as Record<string, number>,
	};
}

/**
 * Serialize outcome shares to JSON string (for database storage)
 */
export function serializeOutcomeShares(
	outcomeShares: Record<string, number>,
): string {
	return JSON.stringify(outcomeShares);
}
