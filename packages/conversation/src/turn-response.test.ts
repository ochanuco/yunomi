import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { turnOutput, turnResponseSchema } from "./turn-response.ts";

const valid = () => ({
	utterance: "こんにちは",
	reply_policy: "reply",
	decision_summary: "挨拶に返答する。",
	emotion_delta: { mood: 0.1, energy: 0 },
	relationship_delta: { familiarity: 0.02, trust: 0 },
	interest_delta: [{ topic: "音楽", delta: 0.1 }],
	memory_candidates: [
		{
			subject: "alice",
			predicate: "好きな飲み物",
			object: { type: "string", value: "緑茶" },
			confidence: 0.9,
			importance: 0.5,
			source: "user_statement",
		},
	],
	open_loop_updates: [{ summary: "予定を聞く", importance: 0.3 }],
	tool_intents: [],
	needs_review: false,
});

const ok = (x: unknown) => v.safeParse(turnResponseSchema, x).success;

describe("turnResponseSchema", () => {
	it("正常な応答を受理する", () => {
		expect(ok(valid())).toBe(true);
	});

	it("ignore のとき utterance は空でよい", () => {
		expect(ok({ ...valid(), reply_policy: "ignore", utterance: "" })).toBe(
			true,
		);
	});

	it("utterance 2000 / decision_summary 200 文字の上限", () => {
		expect(ok({ ...valid(), utterance: "a".repeat(2000) })).toBe(true);
		expect(ok({ ...valid(), utterance: "a".repeat(2001) })).toBe(false);
		expect(ok({ ...valid(), decision_summary: "a".repeat(201) })).toBe(false);
	});

	it("必須欠落・不正な列挙値・範囲外を拒否する", () => {
		const { needs_review: _, ...missing } = valid();
		expect(ok(missing)).toBe(false);
		expect(ok({ ...valid(), reply_policy: "maybe" })).toBe(false);
		const bad = valid();
		bad.memory_candidates = bad.memory_candidates.map((c) => ({
			...c,
			confidence: 1.5,
		}));
		expect(ok(bad)).toBe(false);
	});

	it("JSON Schema は structured outputs の要件を満たす", () => {
		const walk = (n: unknown): void => {
			if (Array.isArray(n)) {
				n.forEach(walk);
				return;
			}
			if (typeof n !== "object" || n === null) return;
			const o = n as Record<string, unknown>;
			if (o.type === "object") {
				expect(o.additionalProperties).toBe(false);
				expect(o.required).toEqual(Object.keys(o.properties as object));
			}
			Object.values(o).forEach(walk);
		};
		walk(turnOutput.jsonSchema);
		expect(turnOutput.name).toBe("turn_response");
		expect(
			Object.keys(turnOutput.jsonSchema.properties as object),
		).toHaveLength(10);
	});
});
