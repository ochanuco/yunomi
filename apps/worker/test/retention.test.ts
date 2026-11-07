import { describe, expect, it } from "vitest";
import {
	FORGETTING,
	isVague,
	lastTouched,
	type RetentionInput,
	retention,
	stabilityDays,
} from "../src/memory-index/retention.ts";

const NOW = new Date("2026-11-07T03:00:00Z");
const daysAgo = (days: number) =>
	new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const base: RetentionInput = {
	kind: "lasting",
	importance: 0.5,
	recallCount: 0,
	restateCount: 0,
	touchedAt: daysAgo(90),
};

describe("保持率", () => {
	it("R = exp(−t / S)", () => {
		const s = stabilityDays(base);
		expect(retention(base, NOW)).toBeCloseTo(Math.exp(-90 / s), 10);
		expect(retention({ ...base, touchedAt: NOW }, NOW)).toBe(1);
		// 未来の時刻は t = 0
		expect(retention({ ...base, touchedAt: daysAgo(-3) }, NOW)).toBe(1);
	});

	it("同じ記憶でも、最近思い出したものは高く、長く触れていないものは低い", () => {
		const observedAt = "2025-11-01T00:00:00.000Z";
		const untouched = retention(
			{ ...base, touchedAt: lastTouched(observedAt, null) },
			NOW,
		);
		const recalled = retention(
			{
				...base,
				recallCount: 1,
				touchedAt: lastTouched(observedAt, daysAgo(2).toISOString()),
			},
			NOW,
		);
		expect(recalled).toBeGreaterThan(0.9);
		expect(untouched).toBeLessThan(0.1);
		expect(isVague(untouched)).toBe(true);
		expect(isVague(recalled)).toBe(false);
	});

	it("importance・想起の回数・同じ話を再び出した回数で S が伸びる", () => {
		const s = stabilityDays(base);
		expect(stabilityDays({ ...base, importance: 1 })).toBeGreaterThan(s);
		expect(stabilityDays({ ...base, recallCount: 1 })).toBeCloseTo(
			s * FORGETTING.recallGrowth,
		);
		// 想起のたびに伸びる
		expect(stabilityDays({ ...base, recallCount: 3 })).toBeCloseTo(
			s * FORGETTING.recallGrowth ** 3,
		);
		expect(stabilityDays({ ...base, restateCount: 1 })).toBeCloseTo(
			s * FORGETTING.restateGrowth,
		);
		expect(stabilityDays({ ...base, recallCount: 1000 })).toBe(
			FORGETTING.maxStabilityDays,
		);
	});

	it("出来事は続く事実より早く薄れる", () => {
		expect(retention({ ...base, kind: "episode" }, NOW)).toBeLessThan(
			retention(base, NOW),
		);
	});
});
