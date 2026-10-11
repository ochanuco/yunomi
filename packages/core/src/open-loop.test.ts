import { describe, expect, it } from "vitest";
import {
	normalizeOpenLoopSummary,
	OPEN_LOOP_MAX_OPEN_PER_ENTITY,
	OPEN_LOOP_MAX_PER_TURN,
	OPEN_LOOP_SUMMARY_MAX_LENGTH,
	type OpenLoopCandidate,
	selectOpenLoopsToAdd,
	validateOpenLoopCandidate,
} from "./open-loop.ts";

const cand = (over: Partial<OpenLoopCandidate> = {}): OpenLoopCandidate => ({
	summary: "面接の結果",
	importance: 0.7,
	dueAt: null,
	dueConfidence: null,
	...over,
});

describe("normalizeOpenLoopSummary", () => {
	it("NFKC・小文字化・空白の圧縮", () => {
		expect(normalizeOpenLoopSummary("  ＡＢＣ　面接   の結果 ")).toBe(
			"abc 面接 の結果",
		);
	});
});

describe("validateOpenLoopCandidate", () => {
	it("due_at を ISO に正規化する", () => {
		expect(
			validateOpenLoopCandidate(
				cand({ dueAt: "2026-10-12T10:00:00+09:00", dueConfidence: 0.6 }),
			),
		).toEqual({
			summary: "面接の結果",
			importance: 0.7,
			dueAt: "2026-10-12T01:00:00.000Z",
			dueConfidence: 0.6,
		});
	});

	it("due_at が無ければ due_confidence は null にそろえる", () => {
		expect(
			validateOpenLoopCandidate(cand({ dueConfidence: 0.9 })),
		).toMatchObject({ dueAt: null, dueConfidence: null });
	});

	it("範囲外・空・長すぎ・読めない日時は clamp せず捨てる", () => {
		expect(validateOpenLoopCandidate(cand({ importance: 1.2 }))).toBeNull();
		expect(validateOpenLoopCandidate(cand({ importance: -0.1 }))).toBeNull();
		expect(
			validateOpenLoopCandidate(cand({ importance: Number.NaN })),
		).toBeNull();
		expect(
			validateOpenLoopCandidate(
				cand({ dueAt: "2026-10-12T00:00:00Z", dueConfidence: 2 }),
			),
		).toBeNull();
		expect(validateOpenLoopCandidate(cand({ summary: "  " }))).toBeNull();
		expect(
			validateOpenLoopCandidate(
				cand({ summary: "あ".repeat(OPEN_LOOP_SUMMARY_MAX_LENGTH + 1) }),
			),
		).toBeNull();
		expect(validateOpenLoopCandidate(cand({ dueAt: "いつか" }))).toBeNull();
	});
});

describe("selectOpenLoopsToAdd", () => {
	it("既存の open と同じ summary（正規化後）は追加しない", () => {
		const r = selectOpenLoopsToAdd(
			[cand({ summary: "面接 の結果" }), cand({ summary: "引っ越し" })],
			["面接　の結果"],
		);
		expect(r.accepted.map((a) => a.summary)).toEqual(["引っ越し"]);
		expect(r.rejected).toEqual([
			{ summary: "面接 の結果", reason: "duplicate" },
		]);
	});

	it("同じターンの候補同士も重複とみなす", () => {
		const r = selectOpenLoopsToAdd([cand(), cand()], []);
		expect(r.accepted).toHaveLength(1);
		expect(r.rejected).toEqual([
			{ summary: "面接の結果", reason: "duplicate" },
		]);
	});

	it("1 ターンの上限を超える分は採らない", () => {
		const r = selectOpenLoopsToAdd(
			["a", "b", "c"].map((summary) => cand({ summary })),
			[],
		);
		expect(r.accepted).toHaveLength(OPEN_LOOP_MAX_PER_TURN);
		expect(r.rejected).toEqual([{ summary: "c", reason: "limit" }]);
	});

	it("entity あたりの open 上限に達していたら追加しない", () => {
		const existing = Array.from(
			{ length: OPEN_LOOP_MAX_OPEN_PER_ENTITY - 1 },
			(_, i) => `既存${i}`,
		);
		const r = selectOpenLoopsToAdd(
			[cand({ summary: "x" }), cand({ summary: "y" })],
			existing,
		);
		expect(r.accepted.map((a) => a.summary)).toEqual(["x"]);
		expect(r.rejected).toEqual([{ summary: "y", reason: "limit" }]);
	});

	it("検証に通らない候補は invalid", () => {
		const r = selectOpenLoopsToAdd([cand({ importance: 2 })], []);
		expect(r.accepted).toEqual([]);
		expect(r.rejected[0]?.reason).toBe("invalid");
	});
});
