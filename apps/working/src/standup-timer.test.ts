import { describe, expect, it } from "vitest";
import { silentLogger } from "./logger.ts";
import { nextStandupAt, startStandupTimer } from "./standup-timer.ts";

const NINE = { hour: 9, minute: 0 };

describe("nextStandupAt", () => {
	it.each([
		// 2026-11-05 は木曜
		[
			"木曜の 8:59 JST なら同じ日の 9:00",
			"2026-11-04T23:59:00Z",
			"2026-11-05T00:00:00Z",
		],
		[
			"木曜の 9:00 ちょうどなら翌日",
			"2026-11-05T00:00:00Z",
			"2026-11-06T00:00:00Z",
		],
		["金曜の 10:00 なら月曜", "2026-11-06T01:00:00Z", "2026-11-09T00:00:00Z"],
		["土曜なら月曜", "2026-11-07T03:00:00Z", "2026-11-09T00:00:00Z"],
		[
			"日曜の 23:59 JST なら月曜",
			"2026-11-08T14:59:00Z",
			"2026-11-09T00:00:00Z",
		],
		// UTC ではまだ日曜でも、JST では月曜の朝
		[
			"月曜の 0:30 JST（UTC では日曜）なら同じ月曜",
			"2026-11-08T15:30:00Z",
			"2026-11-09T00:00:00Z",
		],
		["年をまたぐ", "2026-12-31T05:00:00Z", "2027-01-01T00:00:00Z"],
	])("%s", (_name, now, want) => {
		expect(nextStandupAt(new Date(now), NINE).getTime()).toBe(
			new Date(want).getTime(),
		);
	});

	it("時刻を変えられる", () => {
		expect(
			nextStandupAt(new Date("2026-11-05T00:00:00Z"), { hour: 9, minute: 30 }),
		).toEqual(new Date("2026-11-05T00:30:00Z"));
	});
});

describe("startStandupTimer", () => {
	it("次の平日 9:00 までの時間で予約し、終わったら次を予約する", async () => {
		let clock = new Date("2026-11-06T00:30:00Z");
		const waits: number[] = [];
		const fire: (() => void)[] = [];
		let runs = 0;
		const timer = startStandupTimer({
			at: NINE,
			now: () => clock,
			run: async () => {
				runs++;
			},
			setTimer: (fn, ms) => {
				waits.push(ms);
				fire.push(fn);
				return { cancel: () => {} };
			},
			logger: silentLogger,
		});
		// 金曜 9:30 JST から月曜 9:00 JST まで
		expect(waits).toEqual([(2 * 24 + 23) * 3600_000 + 30 * 60_000]);
		clock = new Date("2026-11-09T00:00:00Z");
		fire[0]?.();
		await new Promise((r) => setTimeout(r, 0));
		expect(runs).toBe(1);
		expect(waits[1]).toBe(24 * 3600_000);
		timer.stop();
	});
});
