import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { ClaudeProvider } from "./claude-provider.ts";
import { defineOutput } from "./json-schema.ts";
import { HAIKU, type LLMRequest, SONNET } from "./types.ts";

const output = defineOutput(
	"reply",
	v.object({
		text: v.pipe(v.string(), v.maxLength(10)),
		note: v.nullable(v.string()),
	}),
);

const req = (model: typeof SONNET | typeof HAIKU = SONNET) =>
	({
		system: [
			{ text: "persona", cache: true },
			{ text: "state", cache: false },
		],
		messages: [{ role: "user", content: "hi" }],
		output,
		model,
		maxTokens: 500,
	}) satisfies LLMRequest<{ text: string; note: string | null }>;

type Call = { url: string; headers: Headers; body: Record<string, unknown> };

const harness = (respond: () => Response) => {
	const calls: Call[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(input instanceof Request ? input.url : input),
			headers: new Headers(init?.headers),
			body: JSON.parse(String(init?.body)),
		});
		return respond();
	}) as typeof globalThis.fetch;
	return { calls, provider: new ClaudeProvider({ apiKey: "k", fetch }) };
};

const message = (text: string, extra: Record<string, unknown> = {}): Response =>
	Response.json({
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "claude-sonnet-5-5",
		content: [{ type: "text", text }],
		stop_reason: "end_turn",
		stop_sequence: null,
		usage: {
			input_tokens: 100,
			output_tokens: 20,
			cache_read_input_tokens: 70,
			cache_creation_input_tokens: 30,
		},
		...extra,
	});

const apiError = (status: number, type: string, headers = {}) =>
	Response.json(
		{ type: "error", error: { type, message: type } },
		{ status, headers },
	);

describe("ClaudeProvider", () => {
	it("正常応答を検証済みオブジェクトと usage で返す", async () => {
		const { provider } = harness(() =>
			message(JSON.stringify({ text: "やあ", note: null })),
		);
		const r = await provider.generate(req());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.output).toEqual({ text: "やあ", note: null });
		expect(r.value.model).toBe("claude-sonnet-5-5");
		expect(r.value.usage).toEqual({
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 70,
			cacheWriteTokens: 30,
		});
		expect(r.value.stopReason).toBe("end_turn");
		expect(r.value.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("Sonnet へは structured output・cache_control・fallback beta を載せる", async () => {
		const { provider, calls } = harness(() =>
			message(JSON.stringify({ text: "a", note: null })),
		);
		await provider.generate(req(SONNET));
		const c = calls[0];
		expect(c?.headers.get("anthropic-beta")).toContain(
			"server-side-fallback-2026-07-01",
		);
		const b = c?.body as Record<string, unknown>;
		expect(b.model).toBe("claude-sonnet-5-5");
		expect(b.fallbacks).toBe("default");
		expect(b.max_tokens).toBe(500);
		expect(b.system).toEqual([
			{ type: "text", text: "persona", cache_control: { type: "ephemeral" } },
			{ type: "text", text: "state" },
		]);
		const oc = b.output_config as {
			effort: string;
			format: { type: string; schema: Record<string, unknown> };
		};
		expect(oc.effort).toBe("low");
		expect(oc.format.type).toBe("json_schema");
		expect(oc.format.schema).toMatchObject({
			type: "object",
			required: ["text", "note"],
			additionalProperties: false,
		});
		expect(JSON.stringify(oc.format.schema)).not.toContain("maxLength");
		for (const k of [
			"temperature",
			"top_p",
			"thinking",
			"tool_choice",
			"tools",
		]) {
			expect(b).not.toHaveProperty(k);
		}
	});

	it("Haiku へは fallback beta を付けない", async () => {
		const { provider, calls } = harness(() =>
			message(JSON.stringify({ text: "a", note: null })),
		);
		await provider.generate(req(HAIKU));
		expect(calls[0]?.headers.get("anthropic-beta")).toBeNull();
		expect(calls[0]?.body).not.toHaveProperty("fallbacks");
		expect(calls[0]?.body.model).toBe("claude-haiku-5-5");
	});

	it("スキーマ不一致・非 JSON は ValidationFailed", async () => {
		const tooLong = harness(() =>
			message(JSON.stringify({ text: "x".repeat(11), note: null })),
		);
		const r1 = await tooLong.provider.generate(req());
		expect(!r1.ok && r1.error.type).toBe("ValidationFailed");
		const notJson = harness(() => message("すみません"));
		const r2 = await notJson.provider.generate(req());
		expect(!r2.ok && r2.error.type).toBe("ValidationFailed");
	});

	it("429 は RateLimited（retry-after を反映）", async () => {
		const { provider, calls } = harness(() =>
			apiError(429, "rate_limit_error", { "retry-after": "3" }),
		);
		const r = await provider.generate(req());
		expect(!r.ok && r.error).toMatchObject({
			type: "RateLimited",
			retryAfterMs: 3000,
		});
		expect(calls).toHaveLength(1);
	});

	it("529 overloaded と 500 は retryable な ExternalServiceUnavailable", async () => {
		for (const status of [529, 500]) {
			const { provider } = harness(() => apiError(status, "overloaded_error"));
			const r = await provider.generate(req());
			expect(!r.ok && r.error).toMatchObject({
				type: "ExternalServiceUnavailable",
				retryable: true,
			});
		}
	});

	it("接続失敗は retryable な ExternalServiceUnavailable", async () => {
		const provider = new ClaudeProvider({
			apiKey: "k",
			fetch: (async () => {
				throw new TypeError("network down");
			}) as typeof globalThis.fetch,
		});
		const r = await provider.generate(req());
		expect(!r.ok && r.error).toMatchObject({
			type: "ExternalServiceUnavailable",
			retryable: true,
		});
	});

	it("400 は retryable ではない", async () => {
		const { provider } = harness(() => apiError(400, "invalid_request_error"));
		const r = await provider.generate(req());
		expect(!r.ok && r.error).toMatchObject({
			type: "ExternalServiceUnavailable",
			retryable: false,
		});
	});

	it("refusal は retryable ではない ExternalServiceUnavailable", async () => {
		const { provider } = harness(() =>
			message("", { stop_reason: "refusal", content: [] }),
		);
		const r = await provider.generate(req());
		expect(!r.ok && r.error).toMatchObject({
			type: "ExternalServiceUnavailable",
			service: "anthropic:refusal",
			retryable: false,
		});
	});

	it("server-side fallback 後は最後の fallback ブロック以降の text を読む", async () => {
		const { provider } = harness(() =>
			message("", {
				model: "claude-haiku-5-5",
				content: [
					{ type: "text", text: "{broken" },
					{ type: "fallback" },
					{ type: "text", text: JSON.stringify({ text: "ok", note: null }) },
				],
			}),
		);
		const r = await provider.generate(req());
		expect(r.ok && r.value.output.text).toBe("ok");
		expect(r.ok && r.value.model).toBe("claude-haiku-5-5");
	});
});
