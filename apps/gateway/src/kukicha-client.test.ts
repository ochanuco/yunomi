import { describe, expect, it, vi } from "vitest";
import { createKukichaClient } from "./kukicha-client.ts";

const rpc = (result: unknown) =>
	new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
		status: 200,
	});

const transcript = (text: string) =>
	rpc({
		content: [{ type: "text", text }],
		structuredContent: { text, duration_ms: 1200 },
	});

const setup = (responses: (Response | Error)[]) => {
	const queue = [...responses];
	const fetchMock = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) => {
			const next = queue.shift();
			if (!next) throw new Error("no more responses");
			if (next instanceof Error) throw next;
			return next;
		},
	);
	const sleep = vi.fn(async (_ms: number) => {});
	const client = createKukichaClient({
		baseUrl: "http://kukicha.lan:8191/",
		token: "secret",
		fetch: fetchMock as unknown as typeof fetch,
		sleep,
	});
	return { client, fetchMock, sleep };
};

const request = { wav: new Uint8Array([1, 2, 3]), speaker: "42" };

describe("transcribe", () => {
	it("tools/call transcribe を Bearer つきで POST し、structuredContent を読む", async () => {
		const { client, fetchMock } = setup([transcript("こんにちは")]);
		const r = await client.transcribe(request);
		expect(r).toEqual({
			ok: true,
			value: { text: "こんにちは", durationMs: 1200 },
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("http://kukicha.lan:8191/mcp");
		expect(
			(init?.headers as Record<string, string> | undefined)?.authorization,
		).toBe("Bearer secret");
		expect(JSON.parse(String(init?.body))).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "transcribe",
				arguments: {
					audio: Buffer.from([1, 2, 3]).toString("base64"),
					language: "ja",
					speaker: "42",
				},
			},
		});
	});

	it("空の text はそのまま返す", async () => {
		const r = await setup([transcript("")]).client.transcribe(request);
		expect(r.ok && r.value.text).toBe("");
	});

	it("接続エラー・5xx は 1 回だけやり直す", async () => {
		const recovered = setup([new TypeError("fetch failed"), transcript("あ")]);
		expect((await recovered.client.transcribe(request)).ok).toBe(true);
		expect(recovered.fetchMock).toHaveBeenCalledTimes(2);

		const down = setup([
			new Response("", { status: 502 }),
			new Response("", { status: 503 }),
		]);
		const r = await down.client.transcribe(request);
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
		expect(down.fetchMock).toHaveBeenCalledTimes(2);
		expect(down.sleep).toHaveBeenCalledTimes(1);
	});

	it("認証の失敗・ツールのエラー・文字の無い応答はやり直さない", async () => {
		for (const res of [
			new Response("", { status: 401 }),
			rpc({ content: [], isError: true }),
			rpc({ content: [] }),
		]) {
			const { client, fetchMock } = setup([res]);
			expect((await client.transcribe(request)).ok).toBe(false);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
	});
});
