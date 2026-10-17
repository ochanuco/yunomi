import * as v from "valibot";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "./contract.ts";
import { parseToolInput } from "./input.ts";

const def: ToolDefinition<{ n: number }> = {
	name: "sample",
	description: "テスト用",
	category: "sample",
	input: v.object({ n: v.number() }),
};

describe("parseToolInput", () => {
	it("適合する入力は検証済みの値を返す", () => {
		const r = parseToolInput(def, { n: 1 });
		expect(r).toEqual({ ok: true, value: { n: 1 } });
	});

	it("不適合な入力は ValidationFailed で、issue にパスとメッセージが 1 行で入る", () => {
		const r = parseToolInput(def, { n: "x" });
		if (r.ok) throw new Error("失敗するはず");
		expect(r.error.type).toBe("ValidationFailed");
		if (r.error.type !== "ValidationFailed") return;
		expect(r.error.issues).toHaveLength(1);
		expect(r.error.issues[0]).toMatch(/^n: /);
	});

	it("パスの無い issue はメッセージだけになる", () => {
		const r = parseToolInput(def, "not an object");
		if (r.ok || r.error.type !== "ValidationFailed") {
			throw new Error("ValidationFailed のはず");
		}
		expect(r.error.issues).toHaveLength(1);
		expect(r.error.issues[0]).not.toMatch(/^: /);
	});
});
