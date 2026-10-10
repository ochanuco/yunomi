import { describe, expect, it } from "vitest";
import { formatJst } from "./time.ts";

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
