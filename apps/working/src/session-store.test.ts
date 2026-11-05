import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openSessionStore } from "./session-store.ts";

describe("openSessionStore", () => {
	it("書いた対応は開き直しても読める", async () => {
		const dir = await mkdtemp(join(tmpdir(), "working-"));
		const a = await openSessionStore(dir);
		expect(a.get("t1")).toBeNull();
		await a.set("t1", "s1");
		await a.set("t2", "s2");
		await a.set("t1", "s3");
		const b = await openSessionStore(dir);
		expect(b.get("t1")).toBe("s3");
		expect(b.get("t2")).toBe("s2");
	});

	it("壊れたファイルは黙って捨てずに失敗させる", async () => {
		const dir = await mkdtemp(join(tmpdir(), "working-"));
		await writeFile(join(dir, "threads.json"), "{");
		await expect(openSessionStore(dir)).rejects.toThrow();
	});
});
