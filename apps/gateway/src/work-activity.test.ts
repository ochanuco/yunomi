import { err, externalServiceUnavailable, ok } from "@yunomi/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger.ts";
import {
	startWorkActivity,
	usageBioBody,
	workActivityText,
} from "./work-activity.ts";
import type { SeatSummary, Usage } from "./working-client.ts";

afterEach(() => {
	vi.useRealTimers();
});

// 2026-11-06 12:40 JST
const now = new Date("2026-11-06T03:40:00Z");
const usage: Usage = {
	// 2026-11-06 18:59:59 JST
	fiveHour: {
		usedPercent: 50.4,
		resetsAt: Date.parse("2026-11-06T09:59:59.6Z"),
	},
	// 2026-11-12 00:59:59 JST
	weekly: { usedPercent: 21.6, resetsAt: Date.parse("2026-11-11T15:59:59.6Z") },
};

describe("workActivityText", () => {
	it("作業中の席と使用率を短く出し、どちらもなければ出さない", () => {
		expect(workActivityText({ working: 0, usage: null })).toBeNull();
		expect(workActivityText({ working: 3, usage: null })).toBe("作業中 3件");
		expect(workActivityText({ working: 0, usage })).toBe("5h 50% · 週 22%");
		expect(workActivityText({ working: 1, usage })).toBe(
			"作業中 1件 · 5h 50% · 週 22%",
		);
	});
});

describe("usageBioBody", () => {
	it("使用率とリセット時刻の下にゲージを置き、時刻は近いほうの分に丸める。今日のリセットは時刻だけ", () => {
		expect(usageBioBody(usage, now)).toBe(
			[
				"5時間 50%・19:00 に戻る",
				"▰▰▰▰▰▱▱▱▱▱",
				"週間 22%・11/12(木) 1:00 に戻る",
				"▰▰▱▱▱▱▱▱▱▱",
			].join("\n"),
		);
		const late: Usage = {
			...usage,
			fiveHour: {
				...usage.fiveHour,
				resetsAt: Date.parse("2026-11-06T10:00:00.6Z"),
			},
		};
		expect(usageBioBody(late, now).split("\n")[0]).toBe(
			"5時間 50%・19:00 に戻る",
		);
	});

	it("使い始めていない枠はリセット時刻を書かず、使用率がなければ空", () => {
		expect(
			usageBioBody(
				{
					fiveHour: { usedPercent: 0, resetsAt: null },
					weekly: { usedPercent: 100, resetsAt: null },
				},
				now,
			),
		).toBe("5時間 0%\n▱▱▱▱▱▱▱▱▱▱\n週間 100%\n▰▰▰▰▰▰▰▰▰▰");
		expect(usageBioBody(null, now)).toBe("");
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

	it("自己紹介欄は本文が変わったときだけ、間隔をあけて書く", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const more: Usage = {
			...usage,
			fiveHour: { ...usage.fiveHour, usedPercent: 70 },
		};
		// 1 分ごとの答え。間隔は 3 分
		const answers: Array<SeatSummary | null> = [
			{ working: 0, usage: null }, // 0 分: 起動直後の空は書かない
			{ working: 0, usage }, // 1 分: 書く
			{ working: 0, usage: more }, // 2 分: 間隔が空いていない
			null, // 3 分: 受付が読めないだけでは消さない
			{ working: 0, usage: more }, // 4 分: 書く
			{ working: 0, usage: more }, // 5 分: 変わっていない
			{ working: 0, usage: null }, // 6 分: 間隔が空いていない
			{ working: 0, usage: null }, // 7 分: 消す
		];
		const seatSummary = vi.fn(async () => {
			const a = answers.shift();
			return a
				? ok(a)
				: err(externalServiceUnavailable({ service: "working" }));
		});
		const setBio = vi.fn(async (_text: string) => true);
		const stop = startWorkActivity({
			working: { seatSummary },
			setActivity: () => {},
			setBio,
			logger: silentLogger,
			bioIntervalMs: 3 * 60_000,
		});
		for (let i = 0; i < 7; i++) await vi.advanceTimersByTimeAsync(60_000);
		stop();

		expect(setBio.mock.calls.map(([t]) => t)).toEqual([
			`${usageBioBody(usage, now)}\n（12:41 時点）`,
			`${usageBioBody(more, now)}\n（12:44 時点）`,
			"",
		]);
	});

	it("自己紹介欄を書けなかったら、次の読み取りで書き直す", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		const setBio = vi
			.fn<(text: string) => Promise<boolean>>()
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
		const stop = startWorkActivity({
			working: { seatSummary: async () => ok({ working: 0, usage }) },
			setActivity: () => {},
			setBio,
			logger: silentLogger,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.advanceTimersByTimeAsync(60_000);
		stop();
		expect(setBio).toHaveBeenCalledTimes(2);
	});
});
