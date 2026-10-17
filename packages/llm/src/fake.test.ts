import { ok } from "@yunomi/core";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { anthropicContinuation } from "./continuation.ts";
import { FakeLLMProvider } from "./fake.ts";
import { defineOutput } from "./json-schema.ts";
import { SONNET, type StepRequest, type StepResult } from "./types.ts";

const output = defineOutput("o", v.object({ a: v.string() }));
const stepReq: StepRequest<{ a: string }> = {
	system: [],
	messages: [],
	tools: [],
	output,
	model: SONNET,
	maxTokens: 10,
};

const meta = {
	model: SONNET,
	usage: {
		inputTokens: 1,
		outputTokens: 1,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	},
	latencyMs: 1,
	stopReason: "end_turn",
};

const toolUse: StepResult<unknown> = {
	kind: "tool_use",
	toolCalls: [{ id: "t1", name: "calendar_list", input: {} }],
	continuation: anthropicContinuation([]),
	...meta,
};
const final: StepResult<unknown> = {
	kind: "final",
	output: { a: "x" },
	...meta,
};

describe("FakeLLMProvider.step", () => {
	it("台本どおり 1 回目は tool_use、2 回目は final を返し、受けたリクエストを残す", async () => {
		const fake = new FakeLLMProvider([], [ok(toolUse)]);
		fake.enqueueStep(ok(final));

		const r1 = await fake.step(stepReq);
		const r2 = await fake.step({ ...stepReq, maxTokens: 20 });

		expect(r1.ok && r1.value.kind).toBe("tool_use");
		expect(r2.ok && r2.value.kind).toBe("final");
		expect(fake.stepRequests.map((q) => q.maxTokens)).toEqual([10, 20]);
		expect(fake.requests).toEqual([]);
	});

	it("台本が尽きたら ExternalServiceUnavailable", async () => {
		const r = await new FakeLLMProvider().step(stepReq);
		expect(!r.ok && r.error).toMatchObject({
			type: "ExternalServiceUnavailable",
			service: "fake-llm-script-empty",
		});
	});
});
