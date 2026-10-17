import type { TurnResponse } from "@yunomi/conversation";
import {
	anthropicContinuation,
	type FakeLLMProvider,
	HAIKU,
	type LLMResultMeta,
} from "@yunomi/llm";

export const turnResponse = (utterance: string): TurnResponse => ({
	utterance,
	reply_policy: "reply",
	decision_summary: "道具の結果を受けて返す",
	emotion_delta: { mood: 0, energy: 0 },
	relationship_delta: { familiarity: 0, trust: 0 },
	interest_signals: [],
	opinion_signals: [],
	memory_candidates: [],
	open_loops: [],
	resolved_open_loop_ids: [],
	performance: {
		emotion: "neutral",
		energy: 0.5,
		pace: "normal",
		warmth: 0.5,
		pause_before_ms: 0,
	},
	speak_aloud: false,
	voice_channel: "stay",
	needs_review: false,
});

export const meta = (model: string): LLMResultMeta => ({
	model,
	usage: {
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	},
	latencyMs: 12,
	stopReason: "end_turn",
});

export type StepScript = Parameters<FakeLLMProvider["enqueueStep"]>[number];

export const final = (
	utterance: string,
	model: string = HAIKU,
): StepScript => ({
	ok: true,
	value: { kind: "final", output: turnResponse(utterance), ...meta(model) },
});

export const toolUse = (
	calls: { name: string; input: unknown }[],
	model: string = HAIKU,
): StepScript => ({
	ok: true,
	value: {
		kind: "tool_use",
		toolCalls: calls.map((c, i) => ({ id: `tu_${i}`, ...c })),
		continuation: anthropicContinuation([]),
		...meta(model),
	},
});
