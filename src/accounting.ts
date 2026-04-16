export const UNIT_SCALE = 10_000;
export const PRICE_SCALE = UNIT_SCALE;

export type UnitAmount = number;
export type PriceUnits = number;
export type ShareUnits = number;

function assertInteger(value: number, label: string): void {
	if (!Number.isInteger(value)) {
		throw new Error(`${label} must be an integer`);
	}
}

function divideRounded(
	numerator: number,
	denominator: number,
	rounding: "floor" | "ceil" | "nearest",
): number {
	switch (rounding) {
		case "floor":
			return Math.floor(numerator / denominator);
		case "ceil":
			return Math.ceil(numerator / denominator);
		case "nearest":
			return Math.round(numerator / denominator);
	}
}

export function coinsToUnits(coins: number): UnitAmount {
	if (!Number.isFinite(coins)) {
		throw new Error("coin amount must be finite");
	}

	return Math.round(coins * UNIT_SCALE);
}

export function unitsToCoins(units: UnitAmount): number {
	return units / UNIT_SCALE;
}

export function contractsToShareUnits(contracts: number): ShareUnits {
	assertInteger(contracts, "contract quantity");
	return contracts * UNIT_SCALE;
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
	return divideRounded(shareUnits * priceUnits, PRICE_SCALE, rounding);
}

export function prorateShareUnits(
	totalShareUnits: ShareUnits,
	numerator: number,
	denominator: number,
): ShareUnits {
	if (denominator <= 0) return 0;
	return divideRounded(totalShareUnits * numerator, denominator, "nearest");
}

export function formatUnits(units: UnitAmount): string {
	const coins = unitsToCoins(units);
	if (Number.isInteger(coins)) {
		return coins.toFixed(0);
	}
	return coins.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatShareUnits(shareUnits: ShareUnits): string {
	const contracts = shareUnitsToContracts(shareUnits);
	if (Number.isInteger(contracts)) {
		return contracts.toFixed(0);
	}
	return contracts.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

export function formatPriceUnits(priceUnits: PriceUnits): string {
	const percent = (priceUnits / PRICE_SCALE) * 100;
	if (Number.isInteger(percent)) {
		return `${percent.toFixed(0)}%`;
	}
	return `${percent.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}
