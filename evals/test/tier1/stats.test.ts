import { describe, expect, it } from "vitest";
import { mean, stddev, variance, wilson } from "../../src/stats.ts";

describe("stats", () => {
	it("平均・不偏分散・標準偏差", () => {
		expect(mean([1, 2, 3])).toBe(2);
		expect(variance([1, 2, 3])).toBe(1);
		expect(stddev([1, 2, 3])).toBe(1);
		expect(variance([5])).toBe(0);
	});

	it("Wilson 区間は既知の値に一致する", () => {
		const ci = wilson(5, 10);
		expect(ci.rate).toBe(0.5);
		expect(ci.low).toBeCloseTo(0.2366, 3);
		expect(ci.high).toBeCloseTo(0.7634, 3);
	});

	it("端の 0/n・n/n でも区間が [0,1] に収まり幅を持つ", () => {
		const zero = wilson(0, 5);
		expect(zero.low).toBe(0);
		expect(zero.high).toBeCloseTo(0.4344, 3);
		const all = wilson(5, 5);
		expect(all.high).toBe(1);
		expect(all.low).toBeCloseTo(0.5655, 3);
	});

	it("n = 0 は全区間", () => {
		const ci = wilson(0, 0);
		expect([ci.low, ci.high]).toEqual([0, 1]);
	});
});
