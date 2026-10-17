import type { ConversationExample } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import { selectExamples } from "./select-examples.ts";

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
		const a = selectExamples(pool, { seed: "t1", count: 3 });
		const b = selectExamples(pool, { seed: "t1", count: 3 });
		expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
	});

	it("場面が重ならない", () => {
		for (const seed of ["a", "b", "c", "d", "e", "f"]) {
			const picked = selectExamples(pool, { seed, count: 4 });
			expect(picked).toHaveLength(4);
			expect(new Set(picked.map((x) => x.scene)).size).toBe(4);
		}
	});

	it("seed が違えば選ばれ方も変わる", () => {
		const keys = new Set(
			["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((seed) =>
				selectExamples(pool, { seed, count: 3 })
					.map((x) => x.id)
					.join(","),
			),
		);
		expect(keys.size).toBeGreaterThan(1);
	});

	it("場面の数より多く求めたら場面ごとに 1 件", () => {
		const picked = selectExamples(pool, { seed: "t", count: 10 });
		expect(picked).toHaveLength(scenes.length);
		expect(new Set(picked.map((x) => x.scene)).size).toBe(scenes.length);
	});

	it("空なら空を返す", () => {
		expect(selectExamples([], { seed: "t", count: 4 })).toEqual([]);
	});
});
