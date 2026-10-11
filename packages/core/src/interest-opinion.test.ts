import { describe, expect, it } from "vitest";
import {
	applyInterestSignals,
	applyOpinionSignals,
	INTEREST_DAILY_CAP,
	INTEREST_LEARNED_DELTA_CAP,
	INTEREST_SIGNAL_STEP,
	type InterestState,
	OPINION_CONFIDENCE_STEP,
	OPINION_REASONS_MAX,
	OPINION_SHIFT_RESET_CONFIDENCE,
	type OpinionState,
	resolveInterests,
	resolveOpinions,
} from "./interest-opinion.ts";
import type { PartnerProfile } from "./partner-profile.ts";

const NOW = new Date("2026-10-11T03:00:00Z");

const interest = (over: Partial<InterestState> = {}): InterestState => ({
	topic: "music",
	label: "音楽",
	score: 0.5,
	baseline: 0.5,
	learnedDelta: 0,
	summary: "仮",
	updatedAt: null,
	source: "profile",
	...over,
});

const opinion = (over: Partial<OpinionState> = {}): OpinionState => ({
	topic: "pace",
	label: "速さ",
	stance: "ゆっくりがよい。",
	confidence: 0.5,
	stability: 0.5,
	reasons: [],
	sourceMemoryIds: [],
	updatedAt: null,
	source: "profile",
	...over,
});

const up = (topic = "music") => ({
	topic,
	direction: "up" as const,
	reason: "r",
});
const down = (topic = "music") => ({
	topic,
	direction: "down" as const,
	reason: "r",
});

describe("resolveInterests / resolveOpinions", () => {
	const profile = {
		interests: [
			{ topic: "music", label: "音楽", baseline: 0.5, summary: "s" },
			{ topic: "moon", label: "月", baseline: 0.3, summary: "m" },
		],
		opinions: [
			{
				topic: "pace",
				label: "速さ",
				stance: "初期",
				confidence: 0.6,
				stability: 0.5,
			},
		],
	} as PartnerProfile;

	it("行の無い topic はプロファイルの初期値で補い、行があればそれを使う", () => {
		const r = resolveInterests(profile, [
			{
				topic: "music",
				score: 0.56,
				baseline: 0.5,
				learnedDelta: 0.06,
				summary: "s",
				updatedAt: "2026-10-10T00:00:00.000Z",
			},
		]);
		expect(r.map((x) => [x.topic, x.score, x.source])).toEqual([
			["music", 0.56, "learned"],
			["moon", 0.3, "profile"],
		]);
		const o = resolveOpinions(profile, []);
		expect(o[0]).toMatchObject({
			stance: "初期",
			confidence: 0.6,
			source: "profile",
			reasons: [],
		});
	});
});

describe("applyInterestSignals", () => {
	it("1 シグナルで score が定数ぶん動き、learned_delta も追従する", () => {
		const r = applyInterestSignals([interest()], [up()], {}, NOW);
		expect(r.changes).toHaveLength(1);
		const after = r.changes[0]?.after;
		expect(after?.score).toBeCloseTo(0.5 + INTEREST_SIGNAL_STEP);
		expect(after?.learnedDelta).toBeCloseTo(INTEREST_SIGNAL_STEP);
		expect(after?.source).toBe("learned");
		expect(after?.updatedAt).toBe(NOW.toISOString());
		expect(r.changes[0]?.before.score).toBe(0.5);
		const d = applyInterestSignals([interest()], [down()], {}, NOW);
		expect(d.changes[0]?.after.score).toBeCloseTo(0.5 - INTEREST_SIGNAL_STEP);
	});

	it("未知の topic は rejected にして何も変えない", () => {
		const r = applyInterestSignals([interest()], [up("nope")], {}, NOW);
		expect(r.changes).toEqual([]);
		expect(r.rejected).toEqual([{ topic: "nope", reason: "unknown_topic" }]);
	});

	it("1 ターンの件数を超えたシグナルは limit で rejected", () => {
		const r = applyInterestSignals(
			[interest(), interest({ topic: "moon" }), interest({ topic: "words" })],
			[up("music"), up("moon"), up("words")],
			{},
			NOW,
		);
		expect(r.changes.map((c) => c.topic)).toEqual(["music", "moon"]);
		expect(r.rejected).toEqual([{ topic: "words", reason: "limit" }]);
	});

	it("日次上限に達した向きは rejected、逆向きは動ける", () => {
		const s = [interest({ score: 0.6, learnedDelta: 0.1 })];
		const capped = applyInterestSignals(
			s,
			[up()],
			{ music: INTEREST_DAILY_CAP },
			NOW,
		);
		expect(capped.changes).toEqual([]);
		expect(capped.rejected).toEqual([{ topic: "music", reason: "daily_cap" }]);
		const back = applyInterestSignals(
			s,
			[down()],
			{ music: INTEREST_DAILY_CAP },
			NOW,
		);
		expect(back.changes).toHaveLength(1);
	});

	it("日次の残りが 1 ステップ未満なら残り分だけ動く", () => {
		const r = applyInterestSignals([interest()], [up()], { music: 0.09 }, NOW);
		expect(r.changes[0]?.after.score).toBeCloseTo(0.51);
	});

	it("同じターンの同じ topic は日次上限に積み上がる", () => {
		const r = applyInterestSignals(
			[interest()],
			[up(), up()],
			{ music: 0.05 },
			NOW,
		);
		expect(r.changes).toHaveLength(1);
		expect(r.changes[0]?.before.score).toBe(0.5);
		expect(r.changes[0]?.after.score).toBeCloseTo(0.55);
	});

	it("learned_delta は ±上限を超えない", () => {
		const high = interest({
			score: 0.5 + INTEREST_LEARNED_DELTA_CAP,
			learnedDelta: INTEREST_LEARNED_DELTA_CAP,
		});
		const r = applyInterestSignals([high], [up()], {}, NOW);
		expect(r.rejected).toEqual([{ topic: "music", reason: "learned_cap" }]);
		const low = interest({
			score: 0.5 - INTEREST_LEARNED_DELTA_CAP,
			learnedDelta: -INTEREST_LEARNED_DELTA_CAP,
		});
		expect(applyInterestSignals([low], [down()], {}, NOW).rejected).toEqual([
			{ topic: "music", reason: "learned_cap" },
		]);
		const near = interest({ score: 0.79, learnedDelta: 0.29 });
		const p = applyInterestSignals([near], [up()], {}, NOW);
		expect(p.changes[0]?.after.score).toBeCloseTo(0.8);
	});

	it("score は 0〜1 に収まる", () => {
		const top = interest({ baseline: 0.9, score: 0.995, learnedDelta: 0.095 });
		expect(
			applyInterestSignals([top], [up()], {}, NOW).changes[0]?.after.score,
		).toBe(1);
		const bottom = interest({
			baseline: 0.1,
			score: 0.01,
			learnedDelta: -0.09,
		});
		expect(
			applyInterestSignals([bottom], [down()], {}, NOW).changes[0]?.after.score,
		).toBe(0);
		const full = interest({ baseline: 0.9, score: 1, learnedDelta: 0.1 });
		expect(applyInterestSignals([full], [up()], {}, NOW).changes).toEqual([]);
	});
});

describe("applyOpinionSignals", () => {
	const sig = (
		direction: "strengthen" | "weaken" | "shift",
		newStance: string | null = null,
	) => ({ topic: "pace", direction, newStance, reason: "理由" });

	it("strengthen / weaken は stability に応じて confidence を動かす", () => {
		const s = opinion({ confidence: 0.5, stability: 0.6 });
		const step = OPINION_CONFIDENCE_STEP * (1 - 0.6);
		const a = applyOpinionSignals([s], [sig("strengthen")], new Set(), NOW);
		expect(a.changes[0]?.after.confidence).toBeCloseTo(0.5 + step);
		expect(a.changes[0]?.after.stance).toBe(s.stance);
		expect(a.changes[0]?.after.reasons).toEqual(["理由"]);
		const b = applyOpinionSignals([s], [sig("weaken")], new Set(), NOW);
		expect(b.changes[0]?.after.confidence).toBeCloseTo(0.5 - step);
	});

	it("confidence は 0〜1 に収まる", () => {
		const hi = opinion({ confidence: 0.99, stability: 0 });
		expect(
			applyOpinionSignals([hi], [sig("strengthen")], new Set(), NOW).changes[0]
				?.after.confidence,
		).toBe(1);
		const lo = opinion({ confidence: 0.01, stability: 0 });
		expect(
			applyOpinionSignals([lo], [sig("weaken")], new Set(), NOW).changes[0]
				?.after.confidence,
		).toBe(0);
	});

	it("shift は confidence が閾値を下回るまで stance を置き換えない", () => {
		const s = opinion({ confidence: 0.5, stability: 0.5 });
		const r = applyOpinionSignals(
			[s],
			[sig("shift", "新しい考え")],
			new Set(),
			NOW,
		);
		expect(r.changes[0]?.after.stance).toBe(s.stance);
		expect(r.changes[0]?.stanceReplaced).toBe(false);
		expect(r.changes[0]?.after.confidence).toBeCloseTo(0.475);
	});

	it("shift で閾値を下回り new_stance があれば stance を置き換えて confidence を戻す", () => {
		const s = opinion({
			confidence: 0.26,
			stability: 0.5,
			reasons: ["古い理由"],
		});
		const r = applyOpinionSignals(
			[s],
			[sig("shift", " 新しい考え ")],
			new Set(),
			NOW,
		);
		const c = r.changes[0];
		expect(c?.stanceReplaced).toBe(true);
		expect(c?.after.stance).toBe("新しい考え");
		expect(c?.after.confidence).toBe(OPINION_SHIFT_RESET_CONFIDENCE);
		expect(c?.after.reasons).toEqual(["理由"]);
	});

	it("閾値を下回っても new_stance が無ければ置き換えない", () => {
		const s = opinion({ confidence: 0.26, stability: 0.5 });
		const r = applyOpinionSignals([s], [sig("shift", null)], new Set(), NOW);
		expect(r.changes[0]?.stanceReplaced).toBe(false);
		expect(r.changes[0]?.after.stance).toBe(s.stance);
		expect(r.changes[0]?.after.confidence).toBeCloseTo(0.235);
	});

	it("new_stance は shift 以外では使わない", () => {
		const s = opinion({ confidence: 0.2 });
		const r = applyOpinionSignals(
			[s],
			[sig("weaken", "別の考え")],
			new Set(),
			NOW,
		);
		expect(r.changes[0]?.after.stance).toBe(s.stance);
	});

	it("同じ topic は生活日に 1 回まで", () => {
		const r = applyOpinionSignals(
			[opinion()],
			[sig("weaken")],
			new Set(["pace"]),
			NOW,
		);
		expect(r.changes).toEqual([]);
		expect(r.rejected).toEqual([{ topic: "pace", reason: "daily_cap" }]);
	});

	it("未知の topic と 2 件目以降は rejected、動けないシグナルは no_change", () => {
		const r = applyOpinionSignals(
			[opinion()],
			[{ ...sig("weaken"), topic: "nope" }, sig("weaken")],
			new Set(),
			NOW,
		);
		expect(r.rejected).toEqual([{ topic: "nope", reason: "unknown_topic" }]);
		const two = applyOpinionSignals(
			[opinion()],
			[sig("weaken"), sig("strengthen")],
			new Set(),
			NOW,
		);
		expect(two.changes).toHaveLength(1);
		expect(two.rejected).toEqual([{ topic: "pace", reason: "limit" }]);
		const fixed = applyOpinionSignals(
			[opinion({ stability: 1 })],
			[sig("weaken")],
			new Set(),
			NOW,
		);
		expect(fixed.rejected).toEqual([{ topic: "pace", reason: "no_change" }]);
	});

	it("reasons は上限まで新しいものを残す", () => {
		const s = opinion({
			reasons: Array.from({ length: OPINION_REASONS_MAX }, (_, i) => `r${i}`),
		});
		const r = applyOpinionSignals([s], [sig("weaken")], new Set(), NOW);
		expect(r.changes[0]?.after.reasons).toEqual([
			"r1",
			"r2",
			"r3",
			"r4",
			"理由",
		]);
	});
});
