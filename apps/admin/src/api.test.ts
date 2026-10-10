import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "./api.ts";
import { status } from "./fixtures.ts";

describe("createApi", () => {
	it("same-origin の /admin/api/ を叩いて契約で検証する", async () => {
		const calls: string[] = [];
		const api = createApi(async (input) => {
			calls.push(String(input));
			return Response.json(status);
		});
		expect(await api.status()).toEqual(status);
		expect(calls).toEqual(["/admin/api/partners/yukarin/status"]);
	});

	it("クエリを付ける", async () => {
		const calls: string[] = [];
		const api = createApi(async (input) => {
			calls.push(String(input));
			return Response.json({ kind: "facts", items: [], next_cursor: null });
		});
		await api.memory({ kind: "facts", limit: 50, cursor: "abc" });
		expect(calls[0]).toBe(
			"/admin/api/partners/yukarin/memory?kind=facts&limit=50&cursor=abc",
		);
	});

	it("HTTP エラーはコード付き", async () => {
		const api = createApi(async () =>
			Response.json({ error: "forbidden" }, { status: 403 }),
		);
		await expect(api.status()).rejects.toThrow("HTTP 403 forbidden");
	});

	it("契約に合わない応答と通信失敗は ApiError", async () => {
		await expect(
			createApi(async () => Response.json({})).status(),
		).rejects.toThrow(ApiError);
		await expect(
			createApi(async () => {
				throw new TypeError("x");
			}).status(),
		).rejects.toThrow(/接続できない/);
	});
});
