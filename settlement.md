This design specification outlines the logic for a zero-liquidity, peer-to-peer prediction market execution engine. The engine facilitates trading across mutually exclusive outcomes by leveraging synthetic matching and pro-rata execution. This engine will be implemented as a typescript module

---

## 1. Core Architecture: The Basket Principle

The engine operates on the fundamental invariant that in a market with  outcomes, a complete set of contracts (one for each outcome) is always worth exactly **1.00** unit of currency.

* **Minting:** The exchange creates new contracts only when the sum of bids for a complete set of outcomes.
* **Redeeming:** The exchange destroys contracts when a user acquires a complete set, converting them back into cash.
* **Liquidity:** No external market maker exists. Liquidity is generated entirely by participants whose collective opposing wagers allow for the minting of new sets.

## 2. Order Validation & Escrow Logic

To ensure the market is always 100% collateralized, the engine enforces a strict escrow policy upon order creation.  Buy orders require an escrow of quantity * price. Sell orders require an escrow of the mint gap: (quantity - current held) * (1 - price).

---

## 3. Matching Algorithm

The engine does not use a standard FIFO (First-In-First-Out) queue. Instead, it uses **Pro-Rata Matching** to resolve price-time ties fairly in a single-order-per-market environment.

### Step 1: Crossing the Book

The engine searches for two types of matches:

1. **Direct Match:** A Buyer of Outcome A and a Seller of Outcome A agree on a price.
2. **Synthetic (Triangle) Match:** Bidders for some or all outcomes in a market collectively offer >= 1.0.

### Step 2: Surplus Distribution

Since the exchange is non-profit, any "spread" or excess bid amount is returned to participants. If a triangle match occurs at a total price greater than 1.0, the  surplus is redistributed pro-rata among the buyers, resulting in an **Effective Price** lower than their original bid.

### Step 3: Pro-Rata Allocation

If the demand for a match at a specific price exceeds the available supply (either from direct sellers or synthetic partners), the fill is distributed proportionally: participant quantity * (available / demand at price)

---

## 4. Execution Lifecycle

1. **Entry:** User submits a `createOrder`. The system calculates `CalculateEscrow` and moves funds from `balance` to `locked`.
2. **Scan:** The engine scans the `Market` for crosses (bids for some or all outcomes in a market collectively sum to >= 1.0).
3. **Atomic Swap:**
 * Cash is deducted from buyers/short-sellers.
 * The Exchange **mints** the necessary baskets.
 * `Holdings` are updated for all `Parties`.
 * Surplus cash is returned to `balance`.
 * `Order.quantity` is decremented.
4. **Cleanup:** Fully filled orders (Quantity = 0) are purged from the `Position`.

## 5. Settlement

Upon `resolveMarket`, the engine identifies the winning `outcomeId`. It iterates through all `Positions`, awarding  per unit of the winning contract held. All other contracts are rendered worthless (deleted), and the market is closed.

---
Use the following npm modules as dependencies:
* snowflakify (for id generation)
* ts-sql (for persistence)

---

The module will have the following data model:

```
/**
 * A unique identifier string (e.g., Snowflake ID from Discord).
 */
type Snowflake = string;

/**
 * Defines the mechanism for resolving the market outcome.
 */
interface Oracle {
  /** 'manual' requires a user to settle; 'ai' uses an automated agent. */
  type: 'manual' | 'ai';
}

/**
 * A manual oracle tied to a specific administrative user.
 */
type ManualOracle = Oracle & {
  type: 'manual';
  userId: Snowflake;
};

/**
 * Represents a prediction market. 
 * A market is a set of mutually exclusive outcomes where exactly one will resolve to true.
 */
interface Market {
  /** Unique ID for the market. */
  id: Snowflake;
  /** The index of the market within the exchange (1-indexed). */
  number: number;
  description: string;
  oracle: Oracle;
  outcomes: Outcome[];
  /** Populated only after the market has been resolved. */
  resolution?: MarketResolution;
  /** Retrieves all participant positions currently associated with this market. */
  positions(): Position[];
}

/**
 * A specific possible result of a market.
 */
type Outcome = {
  id: Snowflake;
  description: string;
  /** The index of the outcome within the market (1-indexed). */
  number: number;
};

/**
 * Data provided when a market is finalized.
 */
type MarketResolution = {
  /** The ID of the outcome that occurred. */
  outcomeId: Snowflake;
};

/**
 * A participant in the exchange.
 */
interface User {
  id: Snowflake;
  /** All positions (holdings + active orders) across all markets. */
  positions(): Position[];
  /** Total cash balance (Liquid + Escrowed). */
  balance(): number;
  /** Spendable balance. 
   * Calculated as: balance() - sum(all active order escrow requirements).
   */
  available(): number;
}

/**
 * 'buy' indicates the user wants to acquire the contract.
 * 'sell' indicates the user wants to reduce a holding or go short.
 */
type Direction = 'buy' | 'sell';

/**
 * A limit order resting on the book.
 * @note Each user is restricted to exactly one order per market.
 */
type Order = {
  outcomeId: Snowflake;
  direction: Direction;
  /** The current unfilled amount of the order. */
  quantity: number;
  /** Price per unit, represented as a fraction of 1 (0 < price <= 1). */
  price: number;
};

/**
 * A user's financial stake in a specific market.
 */
type Position = {
  userId: Snowflake;
  marketId: Snowflake;
  /** * Map of outcomeId to the quantity of contracts owned.
   * A "complete set" (1 of every outcome) is worth 1.00 in cash.
   */
  holdings: Record<Snowflake, number>;
  /** The user's single active order for this market, if any. */
  order?: Order;
};

/**
 * A record of a specific user's involvement in an execution.
 */
type Party = {
  userId: Snowflake;
  outcomeId: Snowflake;
  quantity: number;
  /** The actual price paid/received after surplus distribution. */
  effectivePrice: number;
};

/**
 * A summary of a trade event where orders were matched.
 */
type Execution = {
  marketId: Snowflake;
  /** Unix timestamp of the execution. */
  timestamp: number;
  /** The list of buyers and sellers involved in the match. */
  participants: Party[];
};

/**
 * Logic to determine how much cash must be locked to support an order.
 * * @param position - The current user position in the market.
 * @returns The amount to subtract from the user's available balance.
 * * @example
 * If direction is 'buy': escrow = price * quantity.
 * If direction is 'sell': escrow = max(0, quantity - owned) * (1 - price).
 */
type CalculateEscrow = (position: Position) => number;

/**
 * The core exchange engine responsible for order lifecycle and matching.
 */
interface Exchange {
  /** Initializes a new market with the provided outcomes. */
  createMarket(description: string, oracle: Oracle, outcomes: string[]): Market;
  
  /**
   * Places an order. 
   * @throws Error if user lacks sufficient available() balance.
   * @throws Error if user already has an active order in this market.
   */
  createOrder(userId: Snowflake, outcomeId: Snowflake, quantity: number, price: number): void;
  
  /** Removes the active order from a user's position in a market. */
  cancelOrder(userId: Snowflake, marketId: Snowflake): void;
  
  /**
   * Triggers the matching engine.
   * Finds direct and synthetic (triangle) matches and distributes surplus pro-rata.
   */
  execute(marketId: Snowflake): Execution[];
  
  /**
   * Resolves a market and pays out 1.00 per winning contract to holders. 
   */
  resolveMarket(marketId: Snowflake, outcomeId: Snowflake): MarketResolution;
}
```
