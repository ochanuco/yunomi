import { defineOutput } from "@yunomi/llm";
import * as v from "valibot";

const unit = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

/**
 * 1 ターンの構造化応答。structured outputs の制約で全フィールド必須とし、不在は空配列か null で表す。
 * delta は LLM の生の提案値で、clamp は適用側で行う。
 */
export const turnResponseSchema = v.object({
	utterance: v.pipe(v.string(), v.maxLength(2000)),
	reply_policy: v.picklist(["reply", "ignore"]),
	decision_summary: v.pipe(v.string(), v.maxLength(200)),
	emotion_delta: v.object({ mood: v.number(), energy: v.number() }),
	relationship_delta: v.object({ familiarity: v.number(), trust: v.number() }),
	interest_delta: v.array(v.object({ topic: v.string(), delta: v.number() })),
	memory_candidates: v.array(
		v.object({
			subject: v.string(),
			predicate: v.string(),
			object: v.object({
				type: v.picklist(["string", "number", "boolean", "datetime", "entity"]),
				value: v.string(),
			}),
			confidence: unit,
			importance: unit,
			source: v.picklist(["user_statement", "inferred"]),
		}),
	),
	open_loop_updates: v.array(
		v.object({ summary: v.string(), importance: unit }),
	),
	tool_intents: v.array(v.object({ name: v.string(), summary: v.string() })),
	needs_review: v.boolean(),
});

export type TurnResponse = v.InferOutput<typeof turnResponseSchema>;

export const turnOutput = defineOutput("turn_response", turnResponseSchema);
