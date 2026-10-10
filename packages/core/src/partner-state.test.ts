import { describe, expect, it } from "vitest";
import type { PartnerProfile } from "./partner-profile.ts";
import {
	applyLlmFailure,
	applyLlmSuccess,
	applyRelationshipDelta,
	applyStateDelta,
	type DailyAccumulator,
	initialPartnerState,
	initialRelationship,
} from "./partner-state.ts";

const profile = {
	partner_id: "p",
	initial_state: { mood: 0.2, energy: 0.6 },
	initial_relationship: { familiarity: 0.1, trust: 0.3 },
} as PartnerProfile;

const T = new Date("2026-10-11T03:00:00Z");

describe("初期化", () => {
	it("プロファイルの初期値から作る", () => {
		expect(initialPartnerState(profile, T)).toMatchObject({
			mood: 0.2,
			energy: 0.6,
			presence: "available",
			systemStress: 0,
			degradedMode: false,
			version: 1,
		});
		expect(initialRelationship(profile, "e1", T)).toMatchObject({
			partnerId: "p",
			entityId: "e1",
			familiarity: 0.1,
			trust: 0.3,
			summary: null,
		});
	});
});

describe("applyStateDelta", () => {
	const state = initialPartnerState(profile, T);

	it("ターン上限で clamp する", () => {
		const r = applyStateDelta("p", state, { mood: 0.9, energy: -0.9 }, T);
		expect(r.applied).toEqual({ mood: 0.15, energy: -0.1 });
		expect(r.state.mood).toBeCloseTo(0.35);
		expect(r.state.energy).toBeCloseTo(0.5);
		expect(r.state.version).toBe(2);
		expect(r.rejected).toEqual([]);
	});

	it("値域で clamp し、実際の変化量を applied に返す", () => {
		const r = applyStateDelta(
			"p",
			{ ...state, mood: 0.95, energy: 0.02 },
			{ mood: 0.15, energy: -0.1 },
			T,
		);
		expect(r.state.mood).toBe(1);
		expect(r.state.energy).toBe(0);
		expect(r.applied).toEqual({ mood: 0.05, energy: -0.02 });
	});

	it("変化がなければ state をそのまま返す", () => {
		const r = applyStateDelta("p", state, { mood: 0, energy: 0 }, T);
		expect(r.state).toBe(state);
	});

	it("NaN と |d|>1 は棄却して投げない", () => {
		const r = applyStateDelta("p", state, { mood: Number.NaN, energy: 5 }, T);
		expect(r.state).toBe(state);
		expect(r.rejected.map((e) => e.type)).toEqual([
			"RelationshipUpdateRejected",
			"RelationshipUpdateRejected",
		]);
	});
});

describe("applyRelationshipDelta", () => {
	const rel = initialRelationship(profile, "e1", T);

	it("増加は +0.02、減少は -0.05 が 1 ターンの上限", () => {
		const up = applyRelationshipDelta(
			rel,
			null,
			{ familiarity: 0.5, trust: 0.5 },
			T,
		);
		expect(up.applied).toEqual({ familiarity: 0.02, trust: 0.02 });
		const down = applyRelationshipDelta(
			rel,
			null,
			{ familiarity: -0.5, trust: -0.5 },
			T,
		);
		expect(down.applied).toEqual({ familiarity: -0.05, trust: -0.05 });
	});

	it("値域 0..1 で clamp する", () => {
		const r = applyRelationshipDelta(
			{ ...rel, familiarity: 0.01, trust: 0.995 },
			null,
			{ familiarity: -0.05, trust: 0.02 },
			T,
		);
		expect(r.relationship.familiarity).toBe(0);
		expect(r.relationship.trust).toBe(1);
		expect(r.applied).toEqual({ familiarity: -0.01, trust: 0.005 });
	});

	it("同じ生活日の増加は合計 +0.08 まで", () => {
		let current = rel;
		let acc: DailyAccumulator | null = null;
		const totals: number[] = [];
		for (let i = 0; i < 6; i++) {
			const r = applyRelationshipDelta(
				current,
				acc,
				{ familiarity: 0.02, trust: 0 },
				T,
			);
			current = r.relationship;
			acc = r.accumulator;
			totals.push(r.applied.familiarity);
		}
		expect(totals).toEqual([0.02, 0.02, 0.02, 0.02, 0, 0]);
		expect(current.familiarity).toBeCloseTo(0.18);
		expect(acc).toEqual({ day: "2026-10-11", familiarity: 0.08, trust: 0 });
	});

	it("日次上限に達していても減少は適用できる", () => {
		const acc = { day: "2026-10-11", familiarity: 0.08, trust: 0.08 };
		const r = applyRelationshipDelta(
			rel,
			acc,
			{ familiarity: -0.03, trust: 0.02 },
			T,
		);
		expect(r.applied).toEqual({ familiarity: -0.03, trust: 0 });
	});

	it("生活日の境界（JST 05:00）で日次累計が戻る", () => {
		const acc = { day: "2026-10-10", familiarity: 0.08, trust: 0.08 };
		const before = applyRelationshipDelta(
			rel,
			acc,
			{ familiarity: 0.02, trust: 0.02 },
			new Date("2026-10-10T19:59:00Z"),
		);
		expect(before.applied).toEqual({ familiarity: 0, trust: 0 });
		const after = applyRelationshipDelta(
			rel,
			acc,
			{ familiarity: 0.02, trust: 0.02 },
			new Date("2026-10-10T20:00:00Z"),
		);
		expect(after.applied).toEqual({ familiarity: 0.02, trust: 0.02 });
		expect(after.accumulator.day).toBe("2026-10-11");
	});

	it("NaN・|d|>1 は棄却して理由を残し、他の項目は適用する", () => {
		const r = applyRelationshipDelta(
			rel,
			null,
			{ familiarity: Number.NaN, trust: 0.01 },
			T,
		);
		expect(r.applied).toEqual({ familiarity: 0, trust: 0.01 });
		expect(r.rejected).toHaveLength(1);
		expect(r.rejected[0]).toMatchObject({
			type: "RelationshipUpdateRejected",
			partnerId: "p",
		});
		const big = applyRelationshipDelta(
			rel,
			null,
			{ familiarity: 2, trust: -2 },
			T,
		);
		expect(big.rejected).toHaveLength(2);
		expect(big.relationship).toBe(rel);
	});
});

describe("LLM の健全性による state 遷移", () => {
	const base = initialPartnerState(profile, T);
	const failN = (n: number, from = base, streak = 0) => {
		let u = applyLlmFailure(from, streak, T);
		for (let i = 1; i < n; i++)
			u = applyLlmFailure(u.state, u.failureStreak, T);
		return u;
	};

	it("2 回の失敗では立たず、3 回目で degradedMode と stress +0.2", () => {
		const two = failN(2);
		expect(two.state).toBe(base);
		expect(two.reason).toBeNull();
		const three = failN(3);
		expect(three.state).toMatchObject({
			degradedMode: true,
			systemStress: 0.2,
			version: 2,
		});
		expect(three.reason).toBe("llm_consecutive_failures");
		expect(three.enteredDegraded).toBe(true);
	});

	it("degradedMode 中の失敗は stress が 1 回ごとに +0.1、上限 1.0", () => {
		expect(failN(4).state.systemStress).toBeCloseTo(0.3);
		expect(failN(4).enteredDegraded).toBe(false);
		expect(failN(30).state.systemStress).toBe(1);
	});

	it("成功で degradedMode が戻り、stress は -0.1、下限 0", () => {
		const degraded = failN(3);
		const ok = applyLlmSuccess(degraded.state, T);
		expect(ok.state).toMatchObject({ degradedMode: false, systemStress: 0.1 });
		expect(ok.failureStreak).toBe(0);
		expect(ok.reason).toBe("llm_recovered");
		expect(ok.recovered).toBe(true);
		const again = applyLlmSuccess(ok.state, T);
		expect(again.state.systemStress).toBe(0);
		expect(again.recovered).toBe(false);
		expect(applyLlmSuccess(again.state, T).state).toBe(again.state);
	});

	it("成功を挟むと連続失敗はやり直し", () => {
		const two = failN(2);
		const ok = applyLlmSuccess(two.state, T);
		const next = failN(2, ok.state, ok.failureStreak);
		expect(next.state.degradedMode).toBe(false);
	});
});
