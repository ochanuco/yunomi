import type { ConversationExample } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import { eligibleExamples, selectExamples } from "./select-examples.ts";

const scenes = ["tsukkomi", "bit", "barb", "smug", "plain"] as const;

const pool: ConversationExample[] = scenes.flatMap((scene) =>
	[1, 2, 3, 4].map((n) => ({
		id: `${scene}-${n}`,
		scene,
		turns: [{ speaker: "other" as const, text: "x" }],
	})),
);

describe("selectExamples", () => {
	it("同じ seed なら同じ結果になる", () => {
		const a = selectExamples(pool, { seed: "t1", count: 3, familiarity: 1 });
		const b = selectExamples(pool, { seed: "t1", count: 3, familiarity: 1 });
		expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
	});

	it("場面が重ならない", () => {
		for (const seed of ["a", "b", "c", "d", "e", "f"]) {
			const picked = selectExamples(pool, { seed, count: 4, familiarity: 1 });
			expect(picked).toHaveLength(4);
			expect(new Set(picked.map((x) => x.scene)).size).toBe(4);
		}
	});

	it("seed が違えば選ばれ方も変わる", () => {
		const keys = new Set(
			["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((seed) =>
				selectExamples(pool, { seed, count: 3, familiarity: 1 })
					.map((x) => x.id)
					.join(","),
			),
		);
		expect(keys.size).toBeGreaterThan(1);
	});

	it("場面の数より多く求めたら場面ごとに 1 件", () => {
		const picked = selectExamples(pool, {
			seed: "t",
			count: 10,
			familiarity: 1,
		});
		expect(picked).toHaveLength(scenes.length);
		expect(new Set(picked.map((x) => x.scene)).size).toBe(scenes.length);
	});

	it("空なら空を返す", () => {
		expect(selectExamples([], { seed: "t", count: 4, familiarity: 1 })).toEqual(
			[],
		);
	});

	describe("親しさによる絞り込み", () => {
		const gated: ConversationExample[] = [
			{
				id: "gated",
				scene: "sulk",
				min_familiarity: 0.3,
				turns: [{ speaker: "other", text: "x" }],
			},
			{
				id: "open",
				scene: "plain",
				turns: [{ speaker: "other", text: "x" }],
			},
		];

		it("min_familiarity に満たない例は外し、達したら使える", () => {
			expect(eligibleExamples(gated, 0.29).map((x) => x.id)).toEqual(["open"]);
			expect(eligibleExamples(gated, 0.3).map((x) => x.id)).toEqual([
				"gated",
				"open",
			]);
		});

		it("selectExamples も満たない例を選ばない", () => {
			const low = selectExamples(gated, {
				seed: "s",
				count: 4,
				familiarity: 0.1,
			});
			expect(low.map((x) => x.id)).toEqual(["open"]);
			const high = selectExamples(gated, {
				seed: "s",
				count: 4,
				familiarity: 0.5,
			});
			expect(high).toHaveLength(2);
		});
	});
});
