import { turnResponseSchema } from "@yunomi/conversation";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

const sample = (over: Record<string, unknown> = {}) => ({
	messages: ["おはようございます。", "今日もゆっくり参りましょう。"],
	reply_policy: "reply",
	decision_summary: "メンション付きの挨拶に返答する。",
	emotion_delta: { mood: 0.05, energy: 0 },
	relationship_delta: { familiarity: 0.01, trust: 0 },
	interest_signals: [],
	opinion_signals: [],
	memory_candidates: [],
	open_loops: [],
	resolved_open_loop_ids: [],
	performance: {
		emotion: "neutral",
	},
	speak_aloud: false,
	voice_channel: "stay",
	needs_review: false,
	...over,
});

describe("ターン応答スキーマ（eval が期待する形）", () => {
	it("reply と ignore の代表例を受理する", () => {
		expect(v.safeParse(turnResponseSchema, sample()).success).toBe(true);
		expect(
			v.safeParse(
				turnResponseSchema,
				sample({ reply_policy: "ignore", messages: [] }),
			).success,
		).toBe(true);
	});

	it("reply_policy の不正値と必須フィールド欠落を拒否する", () => {
		expect(
			v.safeParse(turnResponseSchema, sample({ reply_policy: "maybe" }))
				.success,
		).toBe(false);
		const { messages: _, ...rest } = sample();
		expect(v.safeParse(turnResponseSchema, rest).success).toBe(false);
	});
});
