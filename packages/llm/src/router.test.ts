import { externalServiceUnavailable, ok, rateLimited } from "@yunomi/core";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { FakeLLMProvider } from "./fake.ts";
import { defineOutput } from "./json-schema.ts";
import { ModelRouter } from "./router.ts";
import type { LLMResult } from "./types.ts";

const output = defineOutput("o", v.object({ a: v.string() }));
const base = { system: [], messages: [], output, maxTokens: 10 };

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
	it("production は Sonnet、development は Haiku を使う", async () => {
		for (const [env, model] of [
			["production", "claude-sonnet-5-5"],
			["development", "claude-haiku-5-5"],
		] as const) {
			const fake = new FakeLLMProvider([ok(success(model))]);
			const r = await new ModelRouter({ provider: fake, env }).generate(base);
			expect(fake.requests[0]?.model).toBe(model);
			expect(r.ok && r.value.fallbackUsed).toBe(false);
		}
	});

	it("Sonnet の retryable な障害で Haiku に 1 回だけ fallback する", async () => {
		const fake = new FakeLLMProvider([down(), ok(success("claude-haiku-5-5"))]);
		const r = await new ModelRouter({
			provider: fake,
			env: "production",
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
			env: "production",
		}).generate(base);
		expect(fake.requests).toHaveLength(2);
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
	});

	it("dev (Haiku 既定) では fallback しない", async () => {
		const fake = new FakeLLMProvider([down(), ok(success("claude-haiku-5-5"))]);
		const r = await new ModelRouter({
			provider: fake,
			env: "development",
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
		const router = new ModelRouter({ provider: fake, env: "production" });
		const r1 = await router.generate(base);
		const r2 = await router.generate(base);
		expect(fake.requests).toHaveLength(2);
		expect(!r1.ok && r1.error.type).toBe("RateLimited");
		expect(r2.ok).toBe(false);
	});
});
