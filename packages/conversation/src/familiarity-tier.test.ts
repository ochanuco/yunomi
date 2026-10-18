import type { FamiliarityTier } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import { selectFamiliarityTier } from "./familiarity-tier.ts";

const tiers: FamiliarityTier[] = [
	{ min: 0, label: "遠い", text: "a" },
	{ min: 0.3, label: "中", text: "b" },
	{ min: 0.6, label: "近い", text: "c" },
];

describe("selectFamiliarityTier", () => {
	it.each([
		[0, "遠い"],
		[0.29, "遠い"],
		[0.3, "中"],
		[0.59, "中"],
		[0.6, "近い"],
		[1, "近い"],
	])("親しさ %s は %s", (f, label) => {
		expect(selectFamiliarityTier(tiers, f)?.label).toBe(label);
	});

	it("段階がなければ null", () => {
		expect(selectFamiliarityTier(undefined, 0.5)).toBeNull();
	});
});
