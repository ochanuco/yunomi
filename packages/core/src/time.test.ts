import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
	formatJst,
	formatJstForPrompt,
	jstDayNumber,
	lifestyleDay,
	modelDateTime,
	parseModelDateTime,
	readModelDateTime,
	toJstDate,
	toModelJson,
} from "./time.ts";

describe("formatJst", () => {
	it("UTC を JST に変換して整形する", () => {
		expect(formatJst(new Date("2026-01-01T00:00:00Z"))).toBe(
			"2026-01-01 09:00:00",
		);
	});

	it("日付をまたぐ", () => {
		expect(formatJst(new Date("2026-01-01T15:30:00Z"))).toBe(
			"2026-01-02 00:30:00",
		);
	});
});

describe("lifestyleDay", () => {
	it("JST 04:59 は前日の生活日", () => {
		expect(lifestyleDay(new Date("2026-10-10T19:59:00Z"))).toBe("2026-10-10");
	});

	it("JST 05:00 で日が切り替わる", () => {
		expect(lifestyleDay(new Date("2026-10-10T20:00:00Z"))).toBe("2026-10-11");
	});

	it("JST の昼は同じ暦日", () => {
		expect(lifestyleDay(new Date("2026-10-11T03:00:00Z"))).toBe("2026-10-11");
	});

	it("JST 00:00 は前日の生活日", () => {
		expect(lifestyleDay(new Date("2026-10-10T15:00:00Z"))).toBe("2026-10-10");
	});

	it("境界を指定できる", () => {
		expect(lifestyleDay(new Date("2026-10-10T20:00:00Z"), "06:30")).toBe(
			"2026-10-10",
		);
	});
});

describe("formatJstForPrompt", () => {
	it("JST の分まで整形する", () => {
		expect(formatJstForPrompt(new Date("2026-10-18T03:00:30Z"))).toBe(
			"2026-10-18 12:00 JST",
		);
		expect(formatJstForPrompt(new Date("2026-10-18T15:30:00.000Z"))).toBe(
			"2026-10-19 00:30 JST",
		);
	});
});

describe("toJstDate / jstDayNumber", () => {
	it("JST の暦日で読める", () => {
		const d = toJstDate(new Date("2026-10-18T15:00:00Z"));
		expect(d.getUTCMonth() + 1).toBe(10);
		expect(d.getUTCDate()).toBe(19);
	});

	it("UTC では同じ日でも JST で日が変わる", () => {
		const a = jstDayNumber(new Date("2026-10-18T14:59:00Z"));
		const b = jstDayNumber(new Date("2026-10-18T15:00:00Z"));
		expect(b - a).toBe(1);
	});
});

describe("parseModelDateTime", () => {
	it.each([
		["2026-10-18T12:00", "2026-10-18T03:00:00.000Z"],
		["2026-10-18 12:00", "2026-10-18T03:00:00.000Z"],
		["2026-10-18T12:00:00", "2026-10-18T03:00:00.000Z"],
		["2026-10-18T12:00:00Z", "2026-10-18T12:00:00.000Z"],
		["2026-10-18T12:00:00+09:00", "2026-10-18T03:00:00.000Z"],
		["2026-10-18T12:00:00+0900", "2026-10-18T03:00:00.000Z"],
		["2026-10-18T12:00:00-05:00", "2026-10-18T17:00:00.000Z"],
		["2026-10-18T12:00:00.500Z", "2026-10-18T12:00:00.500Z"],
		["2026-10-18", "2026-10-17T15:00:00.000Z"],
	])("%s は %s", (input, expected) => {
		expect(parseModelDateTime(input)).toBe(expected);
	});

	it.each([
		"いつか",
		"",
		"2026-10-18T25:00",
		"Oct 18 2026",
		"2026-10-18+09:00",
	])("読めない値は null: %s", (input) => {
		expect(parseModelDateTime(input)).toBeNull();
	});
});

describe("readModelDateTime / modelDateTime", () => {
	it("読めなければ空文字にする", () => {
		expect(readModelDateTime("2026-10-18T12:00")).toBe(
			"2026-10-18T03:00:00.000Z",
		);
		expect(readModelDateTime("いつか")).toBe("");
	});

	it("codec は検証を失敗させず UTC の ISO を出す", () => {
		expect(v.parse(modelDateTime(), "2026-10-18")).toBe(
			"2026-10-17T15:00:00.000Z",
		);
		expect(v.parse(modelDateTime(), "いつか")).toBe("");
		expect(v.safeParse(modelDateTime(), 1).success).toBe(false);
	});
});

describe("toModelJson", () => {
	it("Date だけを JST の書式にし、ISO らしい文字列はそのまま残す", () => {
		const json = toModelJson({
			start: new Date("2026-10-18T01:00:00Z"),
			end: "2026-10-18T02:00:00Z",
			nested: [{ at: new Date("2026-10-18T15:00:00Z") }],
			day: "2026-10-18",
			n: 1,
		});
		expect(JSON.parse(json)).toEqual({
			start: "2026-10-18 10:00 JST",
			end: "2026-10-18T02:00:00Z",
			nested: [{ at: "2026-10-19 00:00 JST" }],
			day: "2026-10-18",
			n: 1,
		});
	});

	it("読めない Date は null", () => {
		expect(toModelJson({ at: new Date("x") })).toBe('{"at":null}');
	});

	it("トップレベルの Date も変換する", () => {
		expect(toModelJson(new Date("2026-10-18T01:00:00Z"))).toBe(
			'"2026-10-18 10:00 JST"',
		);
	});
});
