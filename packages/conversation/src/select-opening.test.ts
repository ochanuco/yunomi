import { describe, expect, it } from "vitest";
import { OPENINGS, selectOpening } from "./select-opening.ts";

describe("selectOpening", () => {
	it("同じ seed なら同じ入り方を返す", () => {
		expect(selectOpening("m1")).toBe(selectOpening("m1"));
	});

	it("seed が違えば入り方も散らばる", () => {
		const picked = new Set(
			Array.from({ length: 50 }, (_, i) => selectOpening(`m${i}`)),
		);
		expect(picked.size).toBe(OPENINGS.length);
	});
});
