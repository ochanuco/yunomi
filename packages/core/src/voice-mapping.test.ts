import { describe, expect, it } from "vitest";
import type { PerformanceIR } from "./body.ts";
import { resolveAivoiceRealization, toAivoiceValues } from "./voice-mapping.ts";
import type { VoiceProfile } from "./voice-profile.ts";

const master = {
	volume: 1,
	speed: 1,
	pitch: 1,
	pitch_range: 1,
	middle_pause_ms: 150,
	long_pause_ms: 370,
	sentence_pause_ms: 800,
};

const profile: VoiceProfile = {
	traits: { base_pace: 1, base_pitch: 1, expressiveness: 0.7 },
	engines: {
		aivoice: {
			default: "yukari",
			realizations: {
				yukari: {
					preset: "結月 ゆかり",
					emotion_styles: { joy: "J", amused: "J", anger: "A", sorrow: "S" },
					master,
				},
				shizuku: {
					preset: "結月 ゆかり（雫）",
					emotion_styles: {},
					master,
				},
			},
		},
	},
};

const ir = (over: Partial<PerformanceIR> = {}): PerformanceIR => ({
	emotion: "neutral",
	energy: 0.5,
	pace: "normal",
	warmth: 0.5,
	pause_before_ms: 0,
	...over,
});

const styles = (over: Partial<PerformanceIR>) => {
	const v = toAivoiceValues(ir(over), profile);
	return Object.fromEntries(
		(v?.presetOverrides.Styles ?? []).map((s) => [s.Name, s.Value]),
	);
};

describe("toAivoiceValues", () => {
	it("同じ入力から同じ値を返す", () => {
		expect(toAivoiceValues(ir({ emotion: "joy" }), profile)).toEqual(
			toAivoiceValues(ir({ emotion: "joy" }), profile),
		);
	});

	it("A.I.VOICE の実現方法がなければ undefined", () => {
		expect(toAivoiceValues(ir(), { ...profile, engines: {} })).toBeUndefined();
	});

	it("名前で選んだ実現方法のプリセットになり、未指定は default", () => {
		const preset = (name?: string) =>
			toAivoiceValues(ir(), profile, name)?.preset;
		expect(preset()).toBe("結月 ゆかり");
		expect(preset("yukari")).toBe("結月 ゆかり");
		expect(preset("shizuku")).toBe("結月 ゆかり（雫）");
	});

	it("未知の名前は default に戻り、戻ったことが分かる", () => {
		expect(toAivoiceValues(ir(), profile, "nope")?.preset).toBe("結月 ゆかり");
		expect(resolveAivoiceRealization(profile, "nope")).toMatchObject({
			name: "yukari",
			fellBack: true,
		});
		expect(resolveAivoiceRealization(profile, "shizuku")).toMatchObject({
			name: "shizuku",
			fellBack: false,
		});
		expect(resolveAivoiceRealization(profile)?.fellBack).toBe(false);
	});

	it("スタイルを持たない実現方法では Styles を送らない", () => {
		const v = toAivoiceValues(
			ir({ emotion: "joy", energy: 1 }),
			profile,
			"shizuku",
		);
		expect(v?.presetOverrides).toEqual({});
		expect(v?.presetOverrides).not.toHaveProperty("Styles");
	});

	it("感情の違いがスタイル値の違いになる", () => {
		expect(styles({ emotion: "joy", energy: 1 })).toEqual({
			J: 0.7,
			A: 0,
			S: 0,
		});
		expect(styles({ emotion: "anger", energy: 1 })).toEqual({
			J: 0,
			A: 0.7,
			S: 0,
		});
		expect(styles({ emotion: "sorrow", energy: 1 })).toEqual({
			J: 0,
			A: 0,
			S: 0.7,
		});
		expect(styles({ emotion: "amused", energy: 1 })).toEqual(
			styles({ emotion: "joy", energy: 1 }),
		);
	});

	it("対応のない感情では全スタイルを 0 にする", () => {
		expect(styles({ emotion: "neutral", energy: 1 })).toEqual({
			J: 0,
			A: 0,
			S: 0,
		});
		expect(styles({ emotion: "surprised", energy: 1 })).toEqual({
			J: 0,
			A: 0,
			S: 0,
		});
	});

	it("energy が強いほどスタイルが強く、境界でスタイルは 0〜1 に収まる", () => {
		expect(styles({ emotion: "joy", energy: 0 }).J).toBe(0);
		expect(styles({ emotion: "joy", energy: 0.5 }).J).toBeCloseTo(0.35);
		expect(styles({ emotion: "joy", energy: 5 }).J).toBe(0.7);
		expect(styles({ emotion: "joy", energy: -3 }).J).toBe(0);
		const full = toAivoiceValues(ir({ emotion: "joy", energy: 1 }), {
			...profile,
			traits: { ...profile.traits, expressiveness: 1 },
		});
		expect(
			full?.presetOverrides.Styles?.find((s) => s.Name === "J")?.Value,
		).toBe(1);
	});

	it("pace が速いほど Speed が大きい", () => {
		const speed = (pace: PerformanceIR["pace"]) =>
			toAivoiceValues(ir({ pace }), profile)?.masterOverrides.Speed ?? 0;
		expect(speed("slow")).toBeLessThan(speed("slightly_slow"));
		expect(speed("slightly_slow")).toBeLessThan(speed("normal"));
		expect(speed("normal")).toBe(1);
		expect(speed("normal")).toBeLessThan(speed("slightly_fast"));
		expect(speed("slightly_fast")).toBeLessThan(speed("fast"));
	});

	it("標準の IR では基準のマスター値になる", () => {
		expect(toAivoiceValues(ir(), profile)?.masterOverrides).toEqual({
			Volume: 1,
			Speed: 1,
			Pitch: 1,
			PitchRange: 1,
			MiddlePause: 150,
			LongPause: 370,
			SentencePause: 800,
		});
	});

	it("極端な入力でもエンジンの範囲に収まる", () => {
		const extreme: VoiceProfile = {
			traits: { base_pace: 2, base_pitch: 2, expressiveness: 1 },
			engines: {
				aivoice: {
					default: "p",
					realizations: {
						p: {
							preset: "p",
							emotion_styles: {},
							master: {
								volume: 5,
								speed: 4,
								pitch: 2,
								pitch_range: 2,
								middle_pause_ms: 500,
								long_pause_ms: 2000,
								sentence_pause_ms: 10000,
							},
						},
					},
				},
			},
		};
		const m = toAivoiceValues(
			ir({ energy: 1, warmth: 1, pace: "fast" }),
			extreme,
		)?.masterOverrides;
		expect(m).toEqual({
			Volume: 5,
			Speed: 4,
			Pitch: 2,
			PitchRange: 2,
			MiddlePause: 500,
			LongPause: 2000,
			SentencePause: 10000,
		});
		const low = toAivoiceValues(ir({ energy: 0, warmth: 0, pace: "slow" }), {
			...extreme,
			traits: { base_pace: 0.5, base_pitch: 0.5, expressiveness: 0 },
		})?.masterOverrides;
		expect(low?.Speed).toBeGreaterThanOrEqual(0.5);
		expect(low?.Pitch).toBeGreaterThanOrEqual(0.5);
	});

	it("間は整数のミリ秒にする", () => {
		const odd: VoiceProfile = structuredClone(profile);
		const real = odd.engines.aivoice?.realizations.yukari;
		if (!real) throw new Error("fixture");
		real.master = { ...master, middle_pause_ms: 200, long_pause_ms: 370.4 };
		for (const warmth of [0, 0.37, 0.65, 1]) {
			const m = toAivoiceValues(ir({ warmth }), odd)?.masterOverrides;
			expect(Number.isInteger(m?.MiddlePause)).toBe(true);
			expect(Number.isInteger(m?.LongPause)).toBe(true);
			expect(Number.isInteger(m?.SentencePause)).toBe(true);
		}
	});

	it("NaN の energy / warmth は中間値として扱う", () => {
		expect(
			toAivoiceValues(ir({ energy: Number.NaN, warmth: Number.NaN }), profile)
				?.masterOverrides,
		).toEqual(toAivoiceValues(ir(), profile)?.masterOverrides);
	});
});
