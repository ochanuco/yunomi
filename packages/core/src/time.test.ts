import { describe, expect, it } from "vitest";
import { formatJst, lifestyleDay } from "./time.ts";

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
