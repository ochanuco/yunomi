import { describe, expect, it } from "vitest";
import { stateHistory } from "./fixtures.ts";
import {
	changeRows,
	degradedSpans,
	parseDays,
	relationshipSeries,
	stateSeries,
} from "./history.ts";

const t = (iso: string) => Date.parse(iso);
const until = t("2026-10-10T12:00:00.000Z");

describe("parseDays", () => {
	it("24h / 7d / 30d 以外は既定の 7 に倒す", () => {
		expect(parseDays("1")).toBe(1);
		expect(parseDays("30")).toBe(30);
		expect(parseDays("5")).toBe(7);
		expect(parseDays(null)).toBe(7);
	});
});

describe("stateSeries", () => {
	it("開始値から階段状に現在時刻まで伸ばす", () => {
		const pts = stateSeries(stateHistory, "mood", until);
		expect(pts[0]).toEqual({ t: t(stateHistory.since), v: 0.2 });
		expect(pts[1]).toEqual({ t: t("2026-10-10T06:00:00.000Z"), v: 0.2 });
		expect(pts[2]).toEqual({ t: t("2026-10-10T06:00:00.000Z"), v: 0.4 });
		expect(pts.at(-1)).toEqual({ t: until, v: 0.4 });
	});

	it("開始値が無ければ最初の遷移の before から始める", () => {
		const pts = stateSeries(
			{ ...stateHistory, state_at_start: null },
			"mood",
			until,
		);
		expect(pts[0]).toEqual({ t: t("2026-10-10T06:00:00.000Z"), v: 0.2 });
	});

	it("State が何も無ければ空", () => {
		expect(
			stateSeries(
				{ ...stateHistory, state_at_start: null, transitions: [] },
				"mood",
				until,
			),
		).toEqual([]);
	});
});

describe("degradedSpans", () => {
	it("true の区間を返し、続いていれば現在時刻まで", () => {
		expect(degradedSpans(stateHistory, until)).toEqual([
			{
				from: t("2026-10-10T08:00:00.000Z"),
				to: t("2026-10-10T09:00:00.000Z"),
			},
		]);
		const open = {
			...stateHistory,
			transitions: stateHistory.transitions.slice(0, 2),
		};
		expect(degradedSpans(open, until)).toEqual([
			{ from: t("2026-10-10T08:00:00.000Z"), to: until },
		]);
	});
});

describe("relationshipSeries", () => {
	it("最初の点は適用後の値から差分を引いた値", () => {
		const [r] = relationshipSeries(stateHistory, until);
		expect(r?.name).toBe("alice");
		expect(r?.familiarity[0]?.v).toBeCloseTo(0.1);
		expect(r?.trust[0]?.v).toBeCloseTo(0.33);
		expect(r?.familiarity.at(-1)?.v).toBe(0.12);
	});
});

describe("changeRows", () => {
	it("変化した項目だけを新しい順に並べる", () => {
		const rows = changeRows(stateHistory, 50);
		expect(rows.map((r) => `${r.target}:${r.item}`)).toEqual([
			"State:system_stress",
			"State:degraded_mode",
			"State:system_stress",
			"State:degraded_mode",
			"State:mood",
			"State:energy",
			"alice:familiarity",
			"alice:trust",
		]);
		expect(rows[0]?.t).toBeGreaterThanOrEqual(rows.at(-1)?.t ?? 0);
	});

	it("件数を切る", () => {
		expect(changeRows(stateHistory, 2)).toHaveLength(2);
	});
});
