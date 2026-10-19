import type { DomainError, Result } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import type { CallContext, CapabilityResponse } from "../contract.ts";
import { webFetch } from "../definitions/web.ts";
import { createChatsumiAdapter } from "./chatsumi.ts";

type Call = { url: URL; init: RequestInit };
type Step = Response | Error;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const setup = (steps: Step[]) => {
	const calls: Call[] = [];
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({ url: new URL(String(input)), init: init ?? {} });
		const step = steps.shift();
		if (step === undefined) throw new Error("想定外の fetch");
		if (step instanceof Error) throw step;
		return step;
	}) as typeof fetch;
	const adapter = createChatsumiAdapter({
		fetch: fetchFn,
		baseUrl: "https://chatsumi.example.test",
		accessClientId: "id-1",
		accessClientSecret: "secret-1",
	});
	return { adapter, calls };
};

const context: CallContext = {
	partnerId: "partner-1",
	speakerId: "speaker-1",
	isOwner: true,
	channelId: "channel-1",
	sourceMessageId: "1234567890123456789",
	now: new Date("2026-10-19T03:00:00Z"),
};

const read = (
	adapter: ReturnType<typeof setup>["adapter"],
	input: unknown = { url: "https://example.com/post?id=1" },
) =>
	adapter.execute({
		requestId: "req-1",
		tool: webFetch.name,
		input,
		context,
	});

const successOf = (
	r: Result<CapabilityResponse, DomainError>,
): CapabilityResponse => {
	if (!r.ok) throw new Error(`成功のはず: ${r.error.message}`);
	return r.value;
};

const errorOf = (r: Result<CapabilityResponse, DomainError>): DomainError => {
	if (r.ok) throw new Error("失敗のはず");
	return r.error;
};

const page = (over: Record<string, unknown> = {}) => ({
	ok: true,
	title: "記事のタイトル",
	text: "本文です",
	truncated: false,
	finalUrl: "https://example.com/post?id=1",
	mode: "http",
	status: 200,
	...over,
});

const failure = (type: string, mode = "http") => ({
	ok: false,
	error: { type, message: `${type} のメッセージ`, mode },
});

describe("web_fetch", () => {
	it("道具は web_fetch だけ", () => {
		expect(setup([]).adapter.tools).toEqual([webFetch]);
	});

	it("http で読めたページのタイトル・本文・最終 URL・mode を返す", async () => {
		const { adapter } = setup([json(page())]);
		const out = successOf(await read(adapter));
		expect(out.data).toEqual({
			title: "記事のタイトル",
			text: "本文です",
			text_truncated: false,
			final_url: "https://example.com/post?id=1",
			mode: "http",
		});
	});

	it("browser で読めたら mode が browser", async () => {
		const { adapter } = setup([
			json(page({ mode: "browser", finalUrl: "https://example.com/final" })),
		]);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({
			mode: "browser",
			final_url: "https://example.com/final",
		});
	});

	it("タイトルがなければ null", async () => {
		const { adapter } = setup([json(page({ title: null }))]);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({ title: null });
	});

	it("リクエストの URL・メソッド・ヘッダー・本文が仕様どおりで、mode は渡さない", async () => {
		const { adapter, calls } = setup([json(page())]);
		successOf(await read(adapter));
		const [call] = calls;
		expect(call?.url.href).toBe("https://chatsumi.example.test/fetchText");
		expect(call?.init.method).toBe("POST");
		const headers = new Headers(call?.init.headers);
		expect(headers.get("cf-access-client-id")).toBe("id-1");
		expect(headers.get("cf-access-client-secret")).toBe("secret-1");
		expect(headers.get("content-type")).toBe("application/json");
		expect(JSON.parse(String(call?.init.body))).toEqual({
			url: "https://example.com/post?id=1",
		});
	});

	it("baseUrl の末尾のスラッシュは無視する", async () => {
		const calls: string[] = [];
		const adapter = createChatsumiAdapter({
			fetch: (async (input: string | URL | Request) => {
				calls.push(String(input));
				return json(page());
			}) as typeof fetch,
			baseUrl: "https://chatsumi.example.test/",
			accessClientId: "id-1",
			accessClientSecret: "secret-1",
		});
		successOf(await read(adapter));
		expect(calls).toEqual(["https://chatsumi.example.test/fetchText"]);
	});

	it("本文は 4,000 文字で切り詰め、切り詰めたことが分かる", async () => {
		const { adapter } = setup([json(page({ text: "あ".repeat(4_001) }))]);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({
			text: "あ".repeat(4_000),
			text_truncated: true,
		});
	});

	it("ちょうど 4,000 文字なら切り詰めない", async () => {
		const { adapter } = setup([json(page({ text: "a".repeat(4_000) }))]);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({
			text: "a".repeat(4_000),
			text_truncated: false,
		});
	});

	it("chatsumi 側で切り詰められていれば、短くても text_truncated", async () => {
		const { adapter } = setup([json(page({ truncated: true }))]);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({ text_truncated: true });
	});

	it("ssrf_blocked は拒否で、retryable ではない", async () => {
		const { adapter } = setup([json(failure("ssrf_blocked"))]);
		const e = errorOf(await read(adapter));
		expect(e.type).toBe("ToolExecutionRejected");
		expect(e.retryable).toBe(false);
	});

	it.each([
		["challenge", false],
		["forbidden", false],
		["not_found", false],
		["auth_required", false],
		["too_large", false],
		["unsupported_content_type", false],
		["upstream_error", true],
		["timeout", true],
		["network_error", true],
		["browser_unavailable", true],
	])(
		"取得の失敗 %s は ExternalServiceUnavailable（retryable: %s）",
		async (type, retryable) => {
			const { adapter } = setup([json(failure(type, "browser"))]);
			const e = errorOf(await read(adapter));
			expect(e.type).toBe("ExternalServiceUnavailable");
			expect(e.retryable).toBe(retryable);
			expect(e.message).toContain(type);
		},
	);

	it("取得先の rate_limited は RateLimited", async () => {
		const { adapter } = setup([json(failure("rate_limited"))]);
		expect(errorOf(await read(adapter)).type).toBe("RateLimited");
	});

	it.each([401, 403])(
		"Access に弾かれた %s は retryable ではない失敗",
		async (status) => {
			const { adapter } = setup([new Response("denied", { status })]);
			const e = errorOf(await read(adapter));
			expect(e.type).toBe("ExternalServiceUnavailable");
			expect(e.retryable).toBe(false);
			expect(e.message).toContain(String(status));
		},
	);

	it("5xx は retryable", async () => {
		const { adapter } = setup([json({ ok: false }, 502)]);
		const e = errorOf(await read(adapter));
		expect(e.type).toBe("ExternalServiceUnavailable");
		expect(e.retryable).toBe(true);
	});

	it("429 は RateLimited", async () => {
		const { adapter } = setup([json({}, 429)]);
		expect(errorOf(await read(adapter)).type).toBe("RateLimited");
	});

	it("timeout は retryable で、タイムアウトと分かる", async () => {
		const timeout = new DOMException("timed out", "TimeoutError");
		const { adapter } = setup([timeout]);
		const e = errorOf(await read(adapter));
		expect(e.type).toBe("ExternalServiceUnavailable");
		expect(e.retryable).toBe(true);
		expect(e.message).toContain("タイムアウト");
	});

	it("リクエストに timeout の signal を付ける", async () => {
		const { adapter, calls } = setup([json(page())]);
		successOf(await read(adapter));
		expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
	});

	it("ネットワーク失敗は retryable な ExternalServiceUnavailable", async () => {
		const { adapter } = setup([new TypeError("fetch failed")]);
		const e = errorOf(await read(adapter));
		expect(e.type).toBe("ExternalServiceUnavailable");
		expect(e.retryable).toBe(true);
	});

	it("応答が想定と違えば ExternalServiceUnavailable", async () => {
		const { adapter } = setup([json({ unexpected: true })]);
		expect(errorOf(await read(adapter)).type).toBe(
			"ExternalServiceUnavailable",
		);
	});

	it.each([
		["ftp", { url: "ftp://example.com/file" }],
		["file", { url: "file:///etc/passwd" }],
		["javascript", { url: "javascript:alert(1)" }],
		["URL でない", { url: "example.com" }],
		["長すぎる", { url: `https://example.com/${"a".repeat(2_048)}` }],
		["url がない", {}],
		["url が文字列でない", { url: 1 }],
	])("入力が不正（%s）なら fetch せずに ValidationFailed", async (_, input) => {
		const { adapter, calls } = setup([]);
		const e = errorOf(await read(adapter, input));
		expect(e.type).toBe("ValidationFailed");
		expect(calls).toHaveLength(0);
	});

	it("summary はホスト名と mode だけで、パス・クエリ・本文・タイトルを含まない", async () => {
		const { adapter } = setup([
			json(page({ mode: "browser", text: "秘密の本文" })),
		]);
		const out = successOf(
			await read(adapter, {
				url: "https://example.com/private/path?token=abc",
			}),
		);
		expect(out.summary).toBe("example.com を browser で取得");
		expect(out.summary).not.toContain("private");
		expect(out.summary).not.toContain("token");
		expect(out.summary).not.toContain("秘密");
		expect(out.summary).not.toContain("記事");
	});

	it("未知の道具は ValidationFailed", async () => {
		const { adapter } = setup([]);
		const r = await adapter.execute({
			requestId: "req-1",
			tool: "other",
			input: {},
			context,
		});
		expect(errorOf(r).type).toBe("ValidationFailed");
	});
});
