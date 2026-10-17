import * as v from "valibot";
import { describe, expect, it } from "vitest";
import type { CapabilityAdapter, ToolDefinition } from "./contract.ts";
import { createToolRegistry } from "./registry.ts";

const tool = (name: string): ToolDefinition => ({
	name,
	description: name,
	category: "sample",
	input: v.object({}),
});

const adapter = (...names: string[]): CapabilityAdapter => ({
	tools: names.map(tool),
	execute: async () => ({ ok: true, value: { data: null, summary: "" } }),
});

describe("createToolRegistry", () => {
	it("definitions は渡した順のまま並ぶ", () => {
		const r = createToolRegistry([adapter("b", "a"), adapter("c")]);
		if (!r.ok) throw new Error("成功するはず");
		expect(r.value.definitions.map((d) => d.name)).toEqual(["b", "a", "c"]);
	});

	it("find は定義と adapter の組を返し、無ければ undefined", () => {
		const first = adapter("a");
		const second = adapter("b");
		const r = createToolRegistry([first, second]);
		if (!r.ok) throw new Error("成功するはず");
		const found = r.value.find("b");
		expect(found?.definition.name).toBe("b");
		expect(found?.adapter).toBe(second);
		expect(r.value.find("missing")).toBeUndefined();
	});

	it("adapter が無ければ空の登録簿になる", () => {
		const r = createToolRegistry([]);
		if (!r.ok) throw new Error("成功するはず");
		expect(r.value.definitions).toEqual([]);
	});

	it("道具名が adapter をまたいで重複すると ValidationFailed", () => {
		const r = createToolRegistry([adapter("a"), adapter("b", "a")]);
		if (r.ok || r.error.type !== "ValidationFailed") {
			throw new Error("ValidationFailed のはず");
		}
		expect(r.error.issues).toHaveLength(1);
		expect(r.error.issues[0]).toContain("a");
	});

	it("同じ adapter の中の重複も ValidationFailed", () => {
		const r = createToolRegistry([adapter("a", "a")]);
		expect(r.ok).toBe(false);
	});
});
