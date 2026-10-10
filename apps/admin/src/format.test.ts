import { describe, expect, it } from "vitest";
import { jst, jstTime, shortModel } from "./format.ts";

describe("format", () => {
	it("UTC を JST で表示する", () => {
		expect(jst("2026-10-11T15:30:05.000Z")).toBe("2026-10-12 00:30:05");
		expect(jst(null)).toBe("-");
		expect(jstTime(new Date("2026-10-11T03:00:00Z"))).toBe("12:00:00");
	});

	it("モデル名の claude- を省く", () => {
		expect(shortModel("claude-haiku-4-5")).toBe("haiku-4-5");
		expect(shortModel(null)).toBe("-");
	});
});
