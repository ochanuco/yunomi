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

	it("タイムアウトは 1 回だけやり直す", async () => {
		for (const name of ["AbortError", "TimeoutError"]) {
			const { client, fetchMock } = setup([
				new DOMException("timed out", name),
				transcript("あ"),
			]);
			expect((await client.transcribe(request)).ok).toBe(true);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		}
	});

	it("本文を読んでいる間のタイムアウトもやり直す", async () => {
		const slow = {
			ok: true,
			status: 200,
			json: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
		} as unknown as Response;
		const { client, fetchMock } = setup([slow, transcript("あ")]);
		const r = await client.transcribe(request);
		expect(r.ok && r.value.text).toBe("あ");
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("JSON-RPC の error と 429 はやり直さない", async () => {
		const rpcError = setup([
			new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					error: { code: -32602, message: "invalid params" },
				}),
				{ status: 200 },
			),
		]);
		const r = await rpcError.client.transcribe(request);
		expect(!r.ok && r.error.type).toBe("ValidationFailed");
		expect(rpcError.fetchMock).toHaveBeenCalledTimes(1);

		const limited = setup([new Response("", { status: 429 })]);
		const r2 = await limited.client.transcribe(request);
		expect(!r2.ok && r2.error.type).toBe("RateLimited");
		expect(limited.fetchMock).toHaveBeenCalledTimes(1);
	});

	it("accept は application/json だけにする", async () => {
		const { client, fetchMock } = setup([transcript("あ")]);
		await client.transcribe(request);
		const init = fetchMock.mock.calls[0]?.[1];
		expect((init?.headers as Record<string, string> | undefined)?.accept).toBe(
			"application/json",
		);
	});
});
