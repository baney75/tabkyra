/** Dollars for the Costs tab: cents for normal amounts, more digits only when a cost is under a cent. */
export function formatCost(usd: number): string {
	if (!Number.isFinite(usd) || usd === 0) return "$0.00";
	if (Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}
