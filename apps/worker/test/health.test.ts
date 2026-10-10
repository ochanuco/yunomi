import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
	it("DO と D1 に疎通できる", async () => {
		const res = await exports.default.fetch(
			new Request("http://example.com/health"),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			env: "development",
			do: { ok: true, rows: 1 },
			d1: 1,
		});
	});

	it("migration 適用後の partners テーブルがある", async () => {
		const row = await env.DB.prepare(
			"SELECT name FROM sqlite_master WHERE name = 'partners'",
		).first();
		expect(row).not.toBeNull();
	});

	it("未定義のパスは 404", async () => {
		const res = await exports.default.fetch(
			new Request("http://example.com/nope"),
		);
		expect(res.status).toBe(404);
	});
});
