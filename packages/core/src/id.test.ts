import { describe, expect, it } from "vitest";
import { newId, newOpaqueId } from "./id.ts";

describe("newId", () => {
	it("UUID v7 の形式で返す", () => {
		expect(newId()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("連続生成した ID は単調増加する", () => {
		const ids = Array.from({ length: 1000 }, () => newId());
		expect(ids).toEqual([...ids].sort());
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("newOpaqueId", () => {
	it("UUID v4 の形式で返す", () => {
		expect(newOpaqueId()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});
});
