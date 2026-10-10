export const mean = (xs: number[]): number =>
	xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;

/** 不偏分散。サンプルが 2 未満なら 0。 */
export const variance = (xs: number[]): number => {
	if (xs.length < 2) return 0;
	const m = mean(xs);
	return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
};

export const stddev = (xs: number[]): number => Math.sqrt(variance(xs));

export type RateCI = {
	successes: number;
	n: number;
	rate: number;
	low: number;
	high: number;
};

const Z95 = 1.959964;

/** 少数サンプルでも 0/1 近傍で破綻しない Wilson score 区間（95%）。 */
export const wilson = (successes: number, n: number): RateCI => {
	if (n === 0) return { successes, n, rate: Number.NaN, low: 0, high: 1 };
	const p = successes / n;
	const z2 = Z95 ** 2;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const margin =
		(Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
	return {
		successes,
		n,
		rate: p,
		low: Math.max(0, center - margin),
		high: Math.min(1, center + margin),
	};
};
