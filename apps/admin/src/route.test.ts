import { describe, expect, it } from "vitest";
import { buildHash, parseRoute } from "./route.ts";

describe("route", () => {
	it("ハッシュから画面とパラメータを読む", () => {
		const r = parseRoute("#/memory?kind=candidates");
		expect(r.page).toBe("memory");
		expect(r.params.get("kind")).toBe("candidates");
	});

	it("空や未知のパスは State", () => {
		expect(parseRoute("").page).toBe("state");
		expect(parseRoute("#/nope").page).toBe("state");
	});

	it("buildHash は parseRoute と対になる", () => {
		const r = parseRoute(buildHash("audit", { id: "a b" }));
		expect(r.page).toBe("audit");
		expect(r.params.get("id")).toBe("a b");
		expect(buildHash("state")).toBe("#/state");
	});
});
