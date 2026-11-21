import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performanceEmotions } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import {
	createAvatarStock,
	DEFAULT_AVATAR_DIR,
	loadAvatarStock,
} from "./avatar-stock.ts";

describe("loadAvatarStock", () => {
	it("感情ごとのディレクトリから png だけを読む", async () => {
		const dir = await mkdtemp(join(tmpdir(), "avatars-"));
		await mkdir(join(dir, "joy"));
		await writeFile(join(dir, "joy", "b.png"), "");
		await writeFile(join(dir, "joy", "a.png"), "");
		await writeFile(join(dir, "joy", "note.txt"), "");
		await writeFile(join(dir, "README.md"), "");

		const stock = await loadAvatarStock(dir, () => 0.99);
		expect(stock.count()).toBe(2);
		expect(stock.pick("joy")).toEqual({
			name: "b.png",
			path: join(dir, "joy", "b.png"),
		});
		expect(stock.pick("anger")).toBeNull();
	});

	it("ディレクトリが無ければ空として扱う", async () => {
		const stock = await loadAvatarStock(join(tmpdir(), "no-such-avatars"));
		expect(stock.count()).toBe(0);
		expect(stock.pick("joy")).toBeNull();
	});

	it("同梱の画像は声の感情すべてに揃っている", async () => {
		const stock = await loadAvatarStock(DEFAULT_AVATAR_DIR);
		for (const emotion of performanceEmotions) {
			expect(stock.pick(emotion), emotion).not.toBeNull();
		}
	});
});

describe("createAvatarStock", () => {
	it("random の値で 1 枚を選ぶ", () => {
		const images = ["a", "b", "c"].map((n) => ({ name: n, path: `/${n}` }));
		const pickAt = (r: number) =>
			createAvatarStock(new Map([["joy", images]]), () => r).pick("joy")?.name;
		expect([pickAt(0), pickAt(0.5), pickAt(0.999)]).toEqual(["a", "b", "c"]);
	});
});
