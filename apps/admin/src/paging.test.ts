import { describe, expect, it } from "vitest";
import { mergeNewest } from "./paging.ts";

const item = (id: string, at: string, extra = "") => ({ id, at, extra });
const key = (x: { at: string }) => x.at;

describe("mergeNewest", () => {
	it("新しい順に並べ、同じ id は新しい取得結果で置き換える", () => {
		const merged = mergeNewest(
			[item("a", "02"), item("b", "01", "old")],
			[item("c", "03"), item("b", "01", "new")],
			key,
		);
		expect(merged.map((x) => x.id)).toEqual(["c", "a", "b"]);
		expect(merged.find((x) => x.id === "b")?.extra).toBe("new");
	});

	it("同時刻は id の降順で安定する", () => {
		const merged = mergeNewest([item("a", "01")], [item("b", "01")], key);
		expect(merged.map((x) => x.id)).toEqual(["b", "a"]);
	});
});
