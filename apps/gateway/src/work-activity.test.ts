import { err, externalServiceUnavailable, ok } from "@yunomi/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger.ts";
import { startWorkActivity, workActivityText } from "./work-activity.ts";

afterEach(() => {
	vi.useRealTimers();
});

// 2026-11-06 12:40 JST
const now = new Date("2026-11-06T03:40:00Z");
const usage = {
	// 2026-11-06 14:00 JST
	fiveHour: { usedPercent: 32.4, resetsAt: Date.parse("2026-11-06T05:00:00Z") },
	// 2026-11-10 09:00 JST
	weekly: { usedPercent: 11.6, resetsAt: Date.parse("2026-11-10T00:00:00Z") },
};

describe("workActivityText", () => {
	it("作業中の席も使用率もなければ出さない", () => {
		expect(workActivityText({ working: 0, usage: null }, now)).toBeNull();
		expect(workActivityText({ working: 3, usage: null }, now)).toBe(
			"作業中 3件",
		);
	});

	it("使用率を先に、リセット時刻を後ろに置く。今日のリセットは時刻だけ", () => {
		expect(workActivityText({ working: 0, usage }, now)).toBe(
			"5h 32% · 週 12% ｜ 5h は 14:00、週は 11/10(火) 9:00 に戻る",
		);
		expect(workActivityText({ working: 1, usage }, now)).toBe(
			"作業中 1件 · 5h 32% · 週 12% ｜ 5h は 14:00、週は 11/10(火) 9:00 に戻る",
		);
	});

	it("使い始めていない枠はリセット時刻を書かない", () => {
		expect(
			workActivityText(
				{
					working: 0,
					usage: {
						fiveHour: { usedPercent: 0, resetsAt: null },
						weekly: { usedPercent: 0, resetsAt: null },
					},
				},
				now,
			),
		).toBe("5h 0% · 週 0%");
	});
});

describe("startWorkActivity", () => {
	it("1 分おきに席の数を読み、変わったときだけステータスを書き換え、読めなければ消す", async () => {
		vi.useFakeTimers();
		const answers = [
			ok({ working: 2, usage: null }),
			ok({ working: 2, usage: null }),
			err(externalServiceUnavailable({ service: "working" })),
			ok({ working: 0, usage: null }),
			ok({ working: 1, usage: null }),
		];
		const seatSummary = vi.fn(
			async () => answers.shift() ?? ok({ working: 0, usage: null }),
		);
		const setActivity = vi.fn<(text: string | null) => void>();
		const stop = startWorkActivity({
			working: { seatSummary },
			setActivity,
			logger: silentLogger,
		});
		for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(60_000);
		stop();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(seatSummary).toHaveBeenCalledTimes(5);
		expect(setActivity.mock.calls.map(([t]) => t)).toEqual([
			"作業中 2件",
			null,
			"作業中 1件",
		]);
	});
});
