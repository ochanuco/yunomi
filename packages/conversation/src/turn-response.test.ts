import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
	type TurnResponse,
	toBodyIntent,
	turnOutput,
	turnResponseSchema,
} from "./turn-response.ts";

const valid = () => ({
	utterance: "こんにちは",
	reply_policy: "reply",
	decision_summary: "挨拶に返答する。",
	emotion_delta: { mood: 0.1, energy: 0 },
	relationship_delta: { familiarity: 0.02, trust: 0 },
	interest_signals: [
		{ topic: "music", direction: "up", reason: "歌の話で盛り上がった" },
	],
	opinion_signals: [
		{
			topic: "pace",
			direction: "shift",
			new_stance: "速いのも悪くない",
			reason: "実体験を聞いた",
		},
	],
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
	open_loops: [
		{
			summary: "面接の結果を聞く",
			importance: 0.6,
			due_at: "2026-10-12T01:00:00Z",
			due_confidence: 0.5,
		},
	],
	resolved_open_loop_ids: ["01900000-0000-7000-8000-000000000000"],
	performance: {
		emotion: "joy",
		energy: 0.6,
		pace: "slightly_fast",
		warmth: 0.8,
		pause_before_ms: 120,
	},
	speak_aloud: true,
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

	it("open_loops は due_at / due_confidence を null にでき、範囲外や欠落は拒否する", () => {
		const loop = (over: object = {}) => ({
			summary: "結果待ち",
			importance: 0.5,
			due_at: null,
			due_confidence: null,
			...over,
		});
		expect(ok({ ...valid(), open_loops: [loop()] })).toBe(true);
		expect(ok({ ...valid(), open_loops: [loop({ importance: 1.5 })] })).toBe(
			false,
		);
		expect(
			ok({ ...valid(), open_loops: [loop({ due_confidence: -0.1 })] }),
		).toBe(false);
		const { due_at: _, ...noDue } = loop();
		expect(ok({ ...valid(), open_loops: [noDue] })).toBe(false);
		expect(ok({ ...valid(), resolved_open_loop_ids: [1] })).toBe(false);
		const { resolved_open_loop_ids: __, ...missing } = valid();
		expect(ok(missing)).toBe(false);
	});

	it("interest_signals / opinion_signals は向きの列挙と null の new_stance を受け、不正は拒否する", () => {
		const opinion = (over: object = {}) => ({
			topic: "pace",
			direction: "weaken",
			new_stance: null,
			reason: "理由",
			...over,
		});
		expect(ok({ ...valid(), opinion_signals: [opinion()] })).toBe(true);
		expect(
			ok({ ...valid(), opinion_signals: [opinion({ direction: "flip" })] }),
		).toBe(false);
		const { new_stance: _, ...noStance } = opinion();
		expect(ok({ ...valid(), opinion_signals: [noStance] })).toBe(false);
		expect(
			ok({
				...valid(),
				interest_signals: [
					{ topic: "music", direction: "sideways", reason: "" },
				],
			}),
		).toBe(false);
		expect(
			ok({
				...valid(),
				interest_signals: [
					{ topic: "music", direction: "down", reason: "a".repeat(201) },
				],
			}),
		).toBe(false);
	});

	it("performance は列挙値と範囲を検証し、speak_aloud は必須", () => {
		const perf = (over: object = {}) => ({ ...valid().performance, ...over });
		expect(ok({ ...valid(), performance: perf({ emotion: "calm" }) })).toBe(
			false,
		);
		expect(ok({ ...valid(), performance: perf({ pace: "medium" }) })).toBe(
			false,
		);
		expect(ok({ ...valid(), performance: perf({ energy: 1.2 }) })).toBe(false);
		expect(ok({ ...valid(), performance: perf({ warmth: -0.1 }) })).toBe(false);
		expect(ok({ ...valid(), performance: perf({ pause_before_ms: -1 }) })).toBe(
			false,
		);
		const { speak_aloud: _, ...noSpeak } = valid();
		expect(ok(noSpeak)).toBe(false);
		const { performance: __, ...noPerf } = valid();
		expect(ok(noPerf)).toBe(false);
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
		).toHaveLength(14);
	});
});

describe("toBodyIntent", () => {
	const res = (over: Partial<TurnResponse> = {}) =>
		({ ...valid(), ...over }) as TurnResponse;

	it("声で返す応答は speakAloud: true の意図になる", () => {
		expect(toBodyIntent(res(), "can_speak")).toEqual({
			text: "こんにちは",
			performance: valid().performance,
			speakAloud: true,
		});
		expect(toBodyIntent(res(), "asleep")?.speakAloud).toBe(true);
		expect(toBodyIntent(res(), "waking")?.speakAloud).toBe(true);
	});

	it("声で返さない応答は speakAloud: false の意図になる", () => {
		expect(toBodyIntent(res({ speak_aloud: false }), "can_speak")).toEqual({
			text: "こんにちは",
			performance: valid().performance,
			speakAloud: false,
		});
	});

	it("身体が声を出せないときは、モデルが声を選んでも声にしない", () => {
		expect(toBodyIntent(res(), "unavailable")?.speakAloud).toBe(false);
	});

	it("ignore と空の発言は意図にしない", () => {
		expect(
			toBodyIntent(res({ reply_policy: "ignore", utterance: "" }), "can_speak"),
		).toBeUndefined();
		expect(toBodyIntent(res({ utterance: "" }), "can_speak")).toBeUndefined();
	});
});
