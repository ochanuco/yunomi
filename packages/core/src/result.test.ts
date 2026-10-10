import { describe, expect, it } from "vitest";
import { err, ok } from "./result.ts";

describe("Result", () => {
	it("ok は value を持つ", () => {
		expect(ok(1)).toEqual({ ok: true, value: 1 });
	});

	it("err は error を持つ", () => {
		expect(err("x")).toEqual({ ok: false, error: "x" });
	});
});
