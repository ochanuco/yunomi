import { describe, expect, it, vi } from "vitest";
import { createOchokoClient } from "./ochoko-client.ts";

const request = {
	text: "こんにちは",
	values: {
		engine: "aivoice" as const,
		preset: "琴葉 茜",
		presetOverrides: { Styles: [{ Name: "J", Value: 0.5 }] },
		masterOverrides: {
			Volume: 1,
			Speed: 1,
			Pitch: 1,
			PitchRange: 1,
			MiddlePause: 80,
			LongPause: 100,
			SentencePause: 200,
		},
	},
};

const rpc = (result: unknown) =>
	new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
		status: 200,
	});

const audioResult = () =>
	rpc({
		content: [
			{
				type: "audio",
				data: Buffer.from([1, 2, 3]).toString("base64"),
				mimeType: "audio/wav",
			},
		],
		structuredContent: { duration_ms: 1200 },
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
	let clock = 0;
	const sleep = vi.fn(async (ms: number) => {
		clock += ms;
	});
	const client = createOchokoClient({
		baseUrl: "http://ochoko.lan:8190/",
		token: "secret",
		fetch: fetchMock as unknown as typeof fetch,
		sleep,
		now: () => clock,
	});
	return { client, fetchMock, sleep };
};

describe("synthesize", () => {
	it("tools/call synthesize を Bearer つきで POST し、base64 を復号する", async () => {
		const { client, fetchMock } = setup([audioResult()]);
		const r = await client.synthesize(request);
		expect(r.ok && Array.from(r.value.audio)).toEqual([1, 2, 3]);
		expect(r.ok && r.value.durationMs).toBe(1200);
		expect(r.ok && r.value.contentType).toBe("audio/wav");
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("http://ochoko.lan:8190/mcp");
		expect(
			(init?.headers as Record<string, string> | undefined)?.authorization,
		).toBe("Bearer secret");
		expect(JSON.parse(String(init?.body))).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "synthesize",
				arguments: {
					text: "こんにちは",
					preset: "琴葉 茜",
					preset_overrides: request.values.presetOverrides,
					master_overrides: request.values.masterOverrides,
				},
			},
		});
	});

	it("ツールのエラーは再試行できる失敗、音声が無い応答は再試行しない失敗", async () => {
		const busy = await setup([
			rpc({ content: [], isError: true }),
		]).client.synthesize(request);
		expect(!busy.ok && busy.error.retryable).toBe(true);
		const empty = await setup([rpc({ content: [] })]).client.synthesize(
			request,
		);
		expect(!empty.ok && empty.error.retryable).toBe(false);
	});
});

describe("synthesizeWithRetry", () => {
	it("接続エラーは 5 秒おきに再試行して成功を返す", async () => {
		const { client, fetchMock, sleep } = setup([
			new TypeError("fetch failed"),
			new Response("", { status: 502 }),
			audioResult(),
		]);
		const r = await client.synthesizeWithRetry(request);
		expect(r.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenNthCalledWith(1, 5000);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	it("2 分の期限まで失敗が続いたら諦める", async () => {
		const failures = Array.from({ length: 40 }, () => new TypeError("down"));
		const { client, fetchMock } = setup(failures);
		const r = await client.synthesizeWithRetry(request);
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
		// 0, 5, ..., 115 秒に試す
		expect(fetchMock).toHaveBeenCalledTimes(24);
	});

	it("再試行できない失敗はすぐ返す", async () => {
		const { client, fetchMock, sleep } = setup([
			new Response("", { status: 401 }),
		]);
		const r = await client.synthesizeWithRetry(request);
		expect(!r.ok && r.error.type).toBe("PermissionDenied");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});
});

describe("keepAwake", () => {
	it("ttl_seconds と partner_id を送る", async () => {
		const { client, fetchMock } = setup([rpc({ content: [] })]);
		const r = await client.keepAwake({ ttlSeconds: 900, partnerId: "yukarin" });
		expect(r.ok).toBe(true);
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(body.params).toEqual({
			name: "keep_awake",
			arguments: { ttl_seconds: 900, partner_id: "yukarin" },
		});
	});

	it("失敗は Result で返す", async () => {
		const { client } = setup([new Response("", { status: 500 })]);
		const r = await client.keepAwake({ ttlSeconds: 900, partnerId: "yukarin" });
		expect(r.ok).toBe(false);
	});
});
