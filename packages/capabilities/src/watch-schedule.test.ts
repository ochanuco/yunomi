import { describe, expect, it } from "vitest";
import {
	checkWatchSchedule,
	watchScheduleFiredBetween,
} from "./watch-schedule.ts";

// 2026-11-07 は土曜
const now = new Date("2026-11-07T03:00:00Z");

describe("checkWatchSchedule", () => {
	it.each([
		"0 9-18 * * 1-5",
		"*/30 9-21 * * *",
		"0 8,20 * * 0,6",
		"0 9 * * 7",
		"30 0 1 * *",
	])("%s は通る", (schedule) => {
		expect(checkWatchSchedule(schedule, now)).toEqual({
			ok: true,
			value: schedule,
		});
	});

	it("項目の間の空白はそろえる", () => {
		expect(checkWatchSchedule(" 0\t9  * * 1-5 ", now)).toEqual({
			ok: true,
			value: "0 9 * * 1-5",
		});
	});

	it.each([
		"0 9 * *",
		"0 0 9 * * *",
		"@daily",
		"@every 1h",
		"0 9 * * MON",
		"0 9 L * *",
		"60 * * * *",
		"",
	])("5 項目の数字でない「%s」は落とす", (schedule) => {
		expect(checkWatchSchedule(schedule, now).ok).toBe(false);
	});

	it.each([
		"* * * * *",
		"*/29 * * * *",
		"0,10 9 * * *",
		// 23:50 から翌 0:00 の 10 分は日をまたいで初めて見える
		"0,50 0,23 * * *",
		// 1 月 1 日だけ詰まる式も、先まで並べて拾う
		"0,10 9 1 1 *",
	])("30 分より詰めて動く「%s」は落とす", (schedule) => {
		expect(checkWatchSchedule(schedule, now)).toEqual({
			ok: false,
			error: "30 分より短い間隔で動く",
		});
	});

	it("一度も動かない式は落とす", () => {
		expect(checkWatchSchedule("0 0 31 2 *", now)).toEqual({
			ok: false,
			error: "一度も動かない",
		});
	});
});

describe("watchScheduleFiredBetween", () => {
	const weekdays = "0 9-18 * * 1-5";

	it("日本時間で読み、after より後で at までの発火を数える", () => {
		// 月曜 9:00 JST = 00:00Z
		const monday9 = new Date("2026-11-09T00:00:00Z");
		expect(
			watchScheduleFiredBetween(
				weekdays,
				new Date(monday9.getTime() - 1),
				monday9,
			),
		).toBe(true);
		expect(watchScheduleFiredBetween(weekdays, monday9, monday9)).toBe(false);
	});

	it("土日は動かない", () => {
		expect(
			watchScheduleFiredBetween(
				weekdays,
				new Date("2026-11-07T00:00:00Z"),
				new Date("2026-11-08T14:59:00Z"),
			),
		).toBe(false);
	});

	it("読めない式は false", () => {
		expect(watchScheduleFiredBetween("@daily", new Date(0), now)).toBe(false);
	});
});
