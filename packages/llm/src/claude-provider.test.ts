import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { ClaudeProvider } from "./claude-provider.ts";
import { defineOutput } from "./json-schema.ts";
import {
	HAIKU,
	type LLMRequest,
	SONNET,
	type StepRequest,
	type ToolSpec,
} from "./types.ts";

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

	it("timeoutMs を指定すると、既定より短い時間で打ち切って ExternalServiceUnavailable にする", async () => {
		const provider = new ClaudeProvider({
			apiKey: "k",
			fetch: ((_input: unknown, init?: RequestInit) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				})) as typeof globalThis.fetch,
		});
		const started = Date.now();
		const r = await provider.generate({ ...req(HAIKU), timeoutMs: 50 });
		expect(Date.now() - started).toBeLessThan(5000);
		expect(!r.ok && r.error).toMatchObject({
			type: "ExternalServiceUnavailable",
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

const calendarTool = {
	name: "calendar_list",
	description: "予定を一覧する",
	inputSchema: {
		type: "object",
		properties: { from: { type: "string" } },
		required: ["from"],
		additionalProperties: false,
	},
} satisfies ToolSpec;

const stepReq = (
	over: Partial<StepRequest<{ text: string; note: string | null }>> = {},
): StepRequest<{ text: string; note: string | null }> => ({
	...req(),
	tools: [calendarTool],
	...over,
});

const thinking = { type: "thinking", thinking: "考え中", signature: "sig" };
const toolUse = (id: string, input: unknown = { from: "2026-10-17" }) => ({
	type: "tool_use",
	id,
	name: "calendar_list",
	input,
});

const toolUseMessage = (content: unknown[]): Response =>
	message("", { stop_reason: "tool_use", content });

describe("ClaudeProvider.step", () => {
	it("道具を strict なしで載せ、tool_choice は指定せず、Sonnet の beta と structured output も残す", async () => {
		const { provider, calls } = harness(() =>
			message(JSON.stringify({ text: "a", note: null })),
		);
		await provider.step(stepReq());
		const c = calls[0];
		expect(c?.headers.get("anthropic-beta")).toContain(
			"server-side-fallback-2026-07-01",
		);
		const b = c?.body as Record<string, unknown>;
		expect(b.fallbacks).toBe("default");
		expect(b.tools).toEqual([
			{
				name: "calendar_list",
				description: "予定を一覧する",
				input_schema: calendarTool.inputSchema,
			},
		]);
		expect(b).not.toHaveProperty("tool_choice");
		const oc = b.output_config as { format: { type: string } };
		expect(oc.format.type).toBe("json_schema");
	});

	it("Haiku へは fallback beta を付けず、道具は載せる", async () => {
		const { provider, calls } = harness(() =>
			message(JSON.stringify({ text: "a", note: null })),
		);
		await provider.step(stepReq({ model: HAIKU }));
		expect(calls[0]?.headers.get("anthropic-beta")).toBeNull();
		expect(calls[0]?.body).not.toHaveProperty("fallbacks");
		expect(calls[0]?.body.tools).toHaveLength(1);
	});

	it("tool_use 応答は toolCalls と、thinking を含む content 全体の continuation を返す", async () => {
		const content = [thinking, toolUse("toolu_1"), toolUse("toolu_2", {})];
		const { provider } = harness(() => toolUseMessage(content));
		const r = await provider.step(stepReq());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.kind).toBe("tool_use");
		if (r.value.kind !== "tool_use") return;
		expect(r.value.toolCalls).toEqual([
			{ id: "toolu_1", name: "calendar_list", input: { from: "2026-10-17" } },
			{ id: "toolu_2", name: "calendar_list", input: {} },
		]);
		expect(r.value.stopReason).toBe("tool_use");
		expect(r.value.model).toBe("claude-sonnet-5-5");
		expect(r.value.usage.inputTokens).toBe(100);
	});

	it("continuation は assistant の content にそのまま、tool_results は 1 つの user メッセージの tool_result ブロックになる", async () => {
		const content = [thinking, toolUse("toolu_1"), toolUse("toolu_2")];
		const replies = [
			toolUseMessage(content),
			message(JSON.stringify({ text: "a", note: null })),
		];
		const { provider, calls } = harness(() => replies.shift() as Response);

		const first = await provider.step(stepReq());
		if (!first.ok || first.value.kind !== "tool_use") {
			throw new Error("tool_use を期待");
		}
		const second = await provider.step(
			stepReq({
				messages: [
					{ role: "user", content: "明日の予定は？" },
					{ role: "assistant", continuation: first.value.continuation },
					{
						role: "tool_results",
						results: [
							{ toolCallId: "toolu_1", content: "[]", isError: false },
							{ toolCallId: "toolu_2", content: "接続できない", isError: true },
						],
					},
				],
			}),
		);

		expect(calls[1]?.body.messages).toEqual([
			{ role: "user", content: "明日の予定は？" },
			{ role: "assistant", content },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						content: "[]",
						is_error: false,
					},
					{
						type: "tool_result",
						tool_use_id: "toolu_2",
						content: "接続できない",
						is_error: true,
					},
				],
			},
		]);
		expect(second.ok && second.value.kind).toBe("final");
	});

	it("画像つきの結果は tool_result の content を text と image(base64) のブロックにする", async () => {
		const content = [thinking, toolUse("toolu_1")];
		const replies = [
			toolUseMessage(content),
			message(JSON.stringify({ text: "a", note: null })),
		];
		const { provider, calls } = harness(() => replies.shift() as Response);
		const first = await provider.step(stepReq());
		if (!first.ok || first.value.kind !== "tool_use") {
			throw new Error("tool_use を期待");
		}
		await provider.step(
			stepReq({
				messages: [
					{ role: "user", content: "この画像見て" },
					{ role: "assistant", continuation: first.value.continuation },
					{
						role: "tool_results",
						results: [
							{
								toolCallId: "toolu_1",
								content: '{"status":"ok"}',
								images: [{ mediaType: "image/webp", data: "QUJD" }],
								isError: false,
							},
						],
					},
				],
			}),
		);

		const sent = calls[1]?.body.messages as unknown[];
		expect(sent[2]).toEqual({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "toolu_1",
					content: [
						{ type: "text", text: '{"status":"ok"}' },
						{
							type: "image",
							source: {
								type: "base64",
								media_type: "image/webp",
								data: "QUJD",
							},
						},
					],
					is_error: false,
				},
			],
		});
	});

	it("最終応答は thinking を読み飛ばして検証済みの output を返す", async () => {
		const { provider } = harness(() =>
			message("", {
				content: [
					thinking,
					{ type: "text", text: JSON.stringify({ text: "やあ", note: null }) },
				],
			}),
		);
		const r = await provider.step(stepReq());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value).toMatchObject({
			kind: "final",
			output: { text: "やあ", note: null },
			stopReason: "end_turn",
		});
	});

	it("最終応答がスキーマ不一致・非 JSON なら ValidationFailed", async () => {
		const tooLong = harness(() =>
			message(JSON.stringify({ text: "x".repeat(11), note: null })),
		);
		const r1 = await tooLong.provider.step(stepReq());
		expect(!r1.ok && r1.error.type).toBe("ValidationFailed");
		const notJson = harness(() => message("すみません"));
		const r2 = await notJson.provider.step(stepReq());
		expect(!r2.ok && r2.error.type).toBe("ValidationFailed");
	});

	it("stop_reason が tool_use でも tool_use ブロックが無ければ ValidationFailed", async () => {
		const { provider } = harness(() => toolUseMessage([thinking]));
		const r = await provider.step(stepReq());
		expect(!r.ok && r.error.type).toBe("ValidationFailed");
	});

	it("refusal は retryable ではない ExternalServiceUnavailable", async () => {
		const { provider } = harness(() =>
			message("", { stop_reason: "refusal", content: [] }),
		);
		const r = await provider.step(stepReq());
		expect(!r.ok && r.error).toMatchObject({
			type: "ExternalServiceUnavailable",
			service: "anthropic:refusal",
			retryable: false,
		});
	});

	it("529 は retryable な ExternalServiceUnavailable", async () => {
		const { provider } = harness(() => apiError(529, "overloaded_error"));
		const r = await provider.step(stepReq());
		expect(!r.ok && r.error).toMatchObject({
			type: "ExternalServiceUnavailable",
			retryable: true,
		});
	});
});
