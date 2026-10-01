export const UNIT_SCALE = 10_000;
export const PRICE_SCALE = UNIT_SCALE;

export type UnitAmount = number;
export type PriceUnits = number;
export type ShareUnits = number;

function assertInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value)) {
		throw new Error(`${label} must be a safe integer`);
	}
}

export function addUnits(left: number, right: number): number {
	assertInteger(left, "left units");
	assertInteger(right, "right units");
	const result = Number(BigInt(left) + BigInt(right));
	assertInteger(result, "sum");
	return result;
}

function divideRounded(
	numerator: bigint,
	denominator: bigint,
	rounding: "floor" | "ceil" | "nearest",
): number {
	if (denominator <= 0n) throw new Error("denominator must be positive");
	let quotient = numerator / denominator;
	const remainder = numerator % denominator;
	if (rounding === "floor" && remainder < 0n) quotient -= 1n;
	if (rounding === "ceil" && remainder > 0n) quotient += 1n;
	// Ties round toward positive infinity, matching Math.round.
	if (rounding === "nearest") {
		if (remainder > 0n && remainder * 2n >= denominator) quotient += 1n;
		if (remainder < 0n && -remainder * 2n > denominator) quotient -= 1n;
	}
	const result = Number(quotient);
	assertInteger(result, "result");
	return result;
}

export function parseHoldings(json: string): Record<string, ShareUnits> {
	const holdings: unknown = JSON.parse(json);
	if (
		holdings === null ||
		typeof holdings !== "object" ||
		Array.isArray(holdings)
	)
		throw new Error("Holdings must be an object");
	for (const value of Object.values(holdings)) {
		if (!Number.isSafeInteger(value) || value < 0)
			throw new Error("Legacy short or unsafe holdings require reconciliation");
	}
	return holdings as Record<string, ShareUnits>;
}

export function coinsToUnits(coins: number): UnitAmount {
	if (!Number.isFinite(coins)) {
		throw new Error("coin amount must be finite");
	}

	const result = Math.round(coins * UNIT_SCALE);
	assertInteger(result, "coin units");
	return result;
}

export function unitsToCoins(units: UnitAmount): number {
	return units / UNIT_SCALE;
}

export function contractsToShareUnits(contracts: number): ShareUnits {
	assertInteger(contracts, "contract quantity");
	const result = contracts * UNIT_SCALE;
	assertInteger(result, "share units");
	return result;
}

export function shareUnitsToContracts(shareUnits: ShareUnits): number {
	return shareUnits / UNIT_SCALE;
}

export function parsePriceToUnits(price: number): PriceUnits | null {
	if (!Number.isFinite(price) || price <= 0 || price >= 1) {
		return null;
	}

	const cents = Math.round(price * 100);
	if (Math.abs(price * 100 - cents) > 1e-9) {
		return null;
	}

	return cents * (PRICE_SCALE / 100);
}

export function priceUnitsToNumber(priceUnits: PriceUnits): number {
	return priceUnits / PRICE_SCALE;
}

export function multiplySharesByPrice(
	shareUnits: ShareUnits,
	priceUnits: PriceUnits,
	rounding: "floor" | "ceil" | "nearest" = "nearest",
): UnitAmount {
	assertInteger(shareUnits, "share units");
	assertInteger(priceUnits, "price units");
	return divideRounded(
		BigInt(shareUnits) * BigInt(priceUnits),
		BigInt(PRICE_SCALE),
		rounding,
	);
}

export function prorateShareUnits(
	totalShareUnits: ShareUnits,
	numerator: number,
	denominator: number,
	rounding: "floor" | "ceil" | "nearest" = "nearest",
): ShareUnits {
	assertInteger(totalShareUnits, "share units");
	assertInteger(numerator, "numerator");
	assertInteger(denominator, "denominator");
	return divideRounded(
		BigInt(totalShareUnits) * BigInt(numerator),
		BigInt(denominator),
		rounding,
	);
}

/** Allocate every unit exactly once; stable input order breaks remainder ties. */
export function allocateUnits(total: number, weights: number[]): number[] {
	assertInteger(total, "allocation total");
	if (total < 0 || weights.length === 0) throw new Error("invalid allocation");
	for (const weight of weights) {
		assertInteger(weight, "weight");
		if (weight < 0) throw new Error("weight must be nonnegative");
	}
	const denominator = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
	if (denominator === 0n)
		throw new Error("allocation weights must be positive");
	const products = weights.map((weight) => BigInt(total) * BigInt(weight));
	const amounts = products.map((product) => Number(product / denominator));
	const remaining = total - amounts.reduce((sum, amount) => sum + amount, 0);
	const ranked = products.map((product, index) => ({
		index,
		remainder: product % denominator,
	}));
	ranked.sort((a, b) =>
		a.remainder === b.remainder
			? a.index - b.index
			: a.remainder > b.remainder
				? -1
				: 1,
	);
	for (let i = 0; i < remaining; i++) amounts[ranked[i].index] += 1;
	return amounts;
}

export function formatUnits(units: UnitAmount): string {
	assertInteger(units, "units");
	const value = BigInt(units);
	const magnitude = value < 0n ? -value : value;
	const whole = magnitude / BigInt(UNIT_SCALE);
	const fraction = (magnitude % BigInt(UNIT_SCALE))
		.toString()
		.padStart(4, "0")
		.replace(/0+$/, "");
	return `${value < 0n ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function formatShareUnits(shareUnits: ShareUnits): string {
	return formatUnits(shareUnits);
}

export function formatPriceUnits(priceUnits: PriceUnits): string {
	const percent = (priceUnits / PRICE_SCALE) * 100;
	if (Number.isInteger(percent)) {
		return `${percent.toFixed(0)}%`;
	}
	return `${percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}
