import { externalServiceUnavailable, ok, rateLimited } from "@yunomi/core";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { anthropicContinuation } from "./continuation.ts";
import { FakeLLMProvider } from "./fake.ts";
import { defineOutput } from "./json-schema.ts";
import { ModelRouter } from "./router.ts";
import type { LLMResult, StepResult } from "./types.ts";

const output = defineOutput("o", v.object({ a: v.string() }));
const base = { system: [], messages: [], output, maxTokens: 10 };
const stepBase = { ...base, tools: [] };

const success = (model: string): LLMResult<unknown> => ({
	output: { a: "x" },
	model,
	usage: {
		inputTokens: 1,
		outputTokens: 1,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	},
	latencyMs: 1,
	stopReason: "end_turn",
});

const down = () => ({
	ok: false as const,
	error: externalServiceUnavailable({ service: "anthropic" }),
});

describe("ModelRouter", () => {
	it("既定の主モデルは Sonnet", async () => {
		const fake = new FakeLLMProvider([ok(success("claude-sonnet-5-5"))]);
		const r = await new ModelRouter({ provider: fake }).generate(base);
		expect(fake.requests[0]?.model).toBe("claude-sonnet-5-5");
		expect(r.ok && r.value.fallbackUsed).toBe(false);
	});

	it("model を指定すると主モデルの代わりに使い、Haiku の障害では fallback しない", async () => {
		const fake = new FakeLLMProvider([down()]);
		const r = await new ModelRouter({ provider: fake }).generate({
			...base,
			model: "claude-haiku-5-5",
		});
		expect(fake.requests.map((q) => q.model)).toEqual(["claude-haiku-5-5"]);
		expect(r.ok).toBe(false);
	});

	it("Sonnet の retryable な障害で Haiku に 1 回だけ fallback する", async () => {
		const fake = new FakeLLMProvider([down(), ok(success("claude-haiku-5-5"))]);
		const r = await new ModelRouter({
			provider: fake,
		}).generate(base);
		expect(fake.requests.map((q) => q.model)).toEqual([
			"claude-sonnet-5-5",
			"claude-haiku-5-5",
		]);
		expect(r.ok && r.value.fallbackUsed).toBe(true);
	});

	it("fallback も失敗したらその error を返し、3 回目は呼ばない", async () => {
		const fake = new FakeLLMProvider([down(), down(), ok(success("x"))]);
		const r = await new ModelRouter({
			provider: fake,
		}).generate(base);
		expect(fake.requests).toHaveLength(2);
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
	});

	it("主モデルが Haiku なら fallback しない", async () => {
		const fake = new FakeLLMProvider([down(), ok(success("claude-haiku-5-5"))]);
		const r = await new ModelRouter({
			provider: fake,
			primary: "claude-haiku-5-5",
		}).generate(base);
		expect(fake.requests).toHaveLength(1);
		expect(r.ok).toBe(false);
	});

	it("RateLimited / 非 retryable は fallback しない", async () => {
		const fake = new FakeLLMProvider([
			{ ok: false, error: rateLimited() },
			{
				ok: false,
				error: {
					...externalServiceUnavailable({ service: "anthropic:refusal" }),
					retryable: false,
				},
			},
			ok(success("x")),
		]);
		const router = new ModelRouter({ provider: fake });
		const r1 = await router.generate(base);
		const r2 = await router.generate(base);
		expect(fake.requests).toHaveLength(2);
		expect(!r1.ok && r1.error.type).toBe("RateLimited");
		expect(r2.ok).toBe(false);
	});
});

const meta = (model: string) => {
	const { output: _, ...rest } = success(model);
	return rest;
};

const final = (model: string): StepResult<unknown> => ({
	kind: "final",
	output: { a: "x" },
	...meta(model),
});

const toolUse = (model: string): StepResult<unknown> => ({
	kind: "tool_use",
	toolCalls: [{ id: "t1", name: "calendar_list", input: {} }],
	continuation: anthropicContinuation([]),
	...meta(model),
});

describe("ModelRouter.step", () => {
	it("既定の主モデルは Sonnet で、tool_use も final もそのまま返す", async () => {
		const fake = new FakeLLMProvider(
			[],
			[ok(toolUse("claude-sonnet-5-5")), ok(final("claude-sonnet-5-5"))],
		);
		const router = new ModelRouter({ provider: fake });
		const r1 = await router.step(stepBase);
		const r2 = await router.step(stepBase);
		expect(fake.stepRequests.map((q) => q.model)).toEqual([
			"claude-sonnet-5-5",
			"claude-sonnet-5-5",
		]);
		expect(r1.ok && r1.value).toMatchObject({
			kind: "tool_use",
			fallbackUsed: false,
		});
		expect(r2.ok && r2.value).toMatchObject({
			kind: "final",
			fallbackUsed: false,
		});
	});

	it("model を指定すると主モデルの代わりに使い、Haiku の障害では fallback しない", async () => {
		const fake = new FakeLLMProvider([], [down()]);
		const r = await new ModelRouter({ provider: fake }).step({
			...stepBase,
			model: "claude-haiku-5-5",
		});
		expect(fake.stepRequests.map((q) => q.model)).toEqual(["claude-haiku-5-5"]);
		expect(r.ok).toBe(false);
	});

	it("Sonnet の retryable な障害で Haiku に 1 回だけ fallback し、使ったモデルを返す", async () => {
		const fake = new FakeLLMProvider(
			[],
			[down(), ok(toolUse("claude-haiku-5-5"))],
		);
		const r = await new ModelRouter({ provider: fake }).step(stepBase);
		expect(fake.stepRequests.map((q) => q.model)).toEqual([
			"claude-sonnet-5-5",
			"claude-haiku-5-5",
		]);
		expect(r.ok && r.value).toMatchObject({
			kind: "tool_use",
			model: "claude-haiku-5-5",
			fallbackUsed: true,
		});
	});

	it("fallback も失敗したらその error を返し、3 回目は呼ばない", async () => {
		const fake = new FakeLLMProvider(
			[],
			[down(), down(), ok(final("claude-haiku-5-5"))],
		);
		const r = await new ModelRouter({ provider: fake }).step(stepBase);
		expect(fake.stepRequests).toHaveLength(2);
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
	});

	it("RateLimited は fallback しない", async () => {
		const fake = new FakeLLMProvider(
			[],
			[{ ok: false, error: rateLimited() }, ok(final("x"))],
		);
		const r = await new ModelRouter({ provider: fake }).step(stepBase);
		expect(fake.stepRequests).toHaveLength(1);
		expect(!r.ok && r.error.type).toBe("RateLimited");
	});

	it("step を持たない provider では、fallback せず retryable ではない ExternalServiceUnavailable", async () => {
		const generateOnly = {
			generate: async () => down(),
		};
		const r = await new ModelRouter({ provider: generateOnly }).step(stepBase);
		expect(!r.ok && r.error).toMatchObject({
			type: "ExternalServiceUnavailable",
			service: "llm:step-unsupported",
			retryable: false,
		});
	});
});
