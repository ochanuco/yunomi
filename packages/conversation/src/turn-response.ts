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
	/** 興味の向きだけ。大きさは適用側が決める。topic は prompt に示したキーで、不明なものは捨てられる。 */
	interest_signals: v.array(
		v.object({
			topic: v.string(),
			direction: v.picklist(["up", "down"]),
			reason: v.pipe(v.string(), v.maxLength(200)),
		}),
	),
	/** 意見の向きだけ。new_stance は shift のときだけ書き、それ以外は null。 */
	opinion_signals: v.array(
		v.object({
			topic: v.string(),
			direction: v.picklist(["strengthen", "weaken", "shift"]),
			new_stance: v.nullable(v.string()),
			reason: v.pipe(v.string(), v.maxLength(200)),
		}),
	),
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
	/** 相手との間で未解決の話題。なければ空配列。due_at は読み取れたときだけ ISO 8601 で、なければ null。 */
	open_loops: v.array(
		v.object({
			summary: v.string(),
			importance: unit,
			due_at: v.nullable(v.string()),
			due_confidence: v.nullable(unit),
		}),
	),
	/** prompt に示した open の Open Loop のうち、この発言で片づいたものの id。 */
	resolved_open_loop_ids: v.array(v.string()),
	tool_intents: v.array(v.object({ name: v.string(), summary: v.string() })),
	needs_review: v.boolean(),
});

export type TurnResponse = v.InferOutput<typeof turnResponseSchema>;

export const turnOutput = defineOutput("turn_response", turnResponseSchema);
