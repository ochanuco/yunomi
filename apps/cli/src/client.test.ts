import { describe, expect, it } from "vitest";
import { ApiError, createClient, type Fetch } from "./client.ts";
import { auditItem, status } from "./fixtures.ts";

const target = {
	baseUrl: "https://yunomi-dev.example.test",
	headers: { "CF-Access-Client-Id": "id" },
};

const recorder = (res: () => Response) => {
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const f: Fetch = async (url, init) => {
		calls.push({ url, headers: init?.headers as Record<string, string> });
		return res();
	};
	return { f, calls };
};

describe("createClient", () => {
	it("partner 付きの URL に service token ヘッダを付けて GET する", async () => {
		const { f, calls } = recorder(() => Response.json(status));
		expect(await createClient(target, "yukarin", f).status()).toEqual(status);
		expect(calls[0]?.url).toBe(
			"https://yunomi-dev.example.test/admin/api/partners/yukarin/status",
		);
		expect(calls[0]?.headers["CF-Access-Client-Id"]).toBe("id");
	});

	it("クエリを組み立て、undefined は省く", async () => {
		const { f, calls } = recorder(() =>
			Response.json({ items: [auditItem()], next_cursor: null }),
		);
		await createClient(target, "yukarin", f).audit({
			limit: 5,
			since: "2026-10-11T00:00:00.000Z",
		});
		const url = new URL(calls[0]?.url ?? "");
		expect(url.searchParams.get("limit")).toBe("5");
		expect(url.searchParams.get("since")).toBe("2026-10-11T00:00:00.000Z");
		expect(url.searchParams.has("cursor")).toBe(false);
	});

	it("HTTP エラーは error コード付きの ApiError", async () => {
		const { f } = recorder(() =>
			Response.json({ error: "forbidden" }, { status: 403 }),
		);
		await expect(createClient(target, "yukarin", f).status()).rejects.toThrow(
			"HTTP 403 forbidden",
		);
	});

	it("リダイレクトは認証失敗として扱う", async () => {
		const { f } = recorder(
			() =>
				new Response(null, { status: 302, headers: { location: "/login" } }),
		);
		await expect(createClient(target, "yukarin", f).status()).rejects.toThrow(
			/認証されていない/,
		);
	});

	it("契約に合わない応答は拒否する", async () => {
		const { f } = recorder(() => Response.json({ partner_id: "yukarin" }));
		await expect(createClient(target, "yukarin", f).status()).rejects.toThrow(
			ApiError,
		);
	});

	it("接続失敗は ApiError", async () => {
		const f: Fetch = async () => {
			throw new TypeError("fetch failed");
		};
		await expect(createClient(target, "yukarin", f).status()).rejects.toThrow(
			/接続できない/,
		);
	});
});
