import { describe, expect, it } from "vitest";
import type { PerformanceIR } from "./body.ts";
import { resolveAivoiceRealization, toAivoiceValues } from "./voice-mapping.ts";
import type { AivoiceTone, VoiceProfile } from "./voice-profile.ts";

const master = {
	volume: 1,
	speed: 1,
	pitch: 1,
	pitch_range: 1,
	middle_pause_ms: 150,
	long_pause_ms: 370,
	sentence_pause_ms: 800,
};

const tone = (over: Partial<AivoiceTone> = {}): AivoiceTone => ({
	strength: 0,
	volume: 1,
	speed: 1,
	pitch: 1,
	pitch_range: 1,
	middle_pause: 1,
	...over,
});

const profile: VoiceProfile = {
	engines: {
		aivoice: {
			default: "yukari",
			realizations: {
				yukari: {
					preset: "結月 ゆかり",
					styles: ["J", "A", "S"],
					tones: {
						joy: tone({ style: "J", strength: 0.4 }),
						amused: tone({ style: "J", strength: 0.2 }),
						sorrow: tone({ style: "S", strength: 0.3 }),
						anger: tone({ pitch_range: 0.85, speed: 0.95, middle_pause: 1.2 }),
					},
					master,
				},
				shizuku: {
					preset: "結月 ゆかり（雫）",
					styles: [],
					tones: {},
					master,
				},
			},
		},
	},
};

const ir = (over: Partial<PerformanceIR> = {}): PerformanceIR => ({
	emotion: "neutral",
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
		const v = toAivoiceValues(ir({ emotion: "joy" }), profile, "shizuku");
		expect(v?.presetOverrides).toEqual({});
		expect(v?.presetOverrides).not.toHaveProperty("Styles");
	});

	it("感情のトーンのスタイルだけを強め、ほかのスタイルは 0 で送る", () => {
		expect(styles({ emotion: "joy" })).toEqual({ J: 0.4, A: 0, S: 0 });
		expect(styles({ emotion: "amused" })).toEqual({ J: 0.2, A: 0, S: 0 });
		expect(styles({ emotion: "sorrow" })).toEqual({ J: 0, A: 0, S: 0.3 });
		expect(styles({ emotion: "anger" })).toEqual({ J: 0, A: 0, S: 0 });
	});

	it("トーンのない感情は、スタイルなし・基準のマスター値で読む", () => {
		for (const emotion of ["neutral", "surprised"] as const) {
			expect(styles({ emotion })).toEqual({ J: 0, A: 0, S: 0 });
			expect(
				toAivoiceValues(ir({ emotion }), profile)?.masterOverrides,
			).toEqual({
				Volume: 1,
				Speed: 1,
				Pitch: 1,
				PitchRange: 1,
				MiddlePause: 150,
				LongPause: 370,
				SentencePause: 800,
			});
		}
	});

	it("トーンの倍率をマスター値に掛ける", () => {
		expect(
			toAivoiceValues(ir({ emotion: "anger" }), profile)?.masterOverrides,
		).toEqual({
			Volume: 1,
			Speed: 0.95,
			Pitch: 1,
			PitchRange: 0.85,
			MiddlePause: 180,
			LongPause: 370,
			SentencePause: 800,
		});
	});

	it("極端な入力でもエンジンの範囲に収まる", () => {
		const extreme: VoiceProfile = {
			engines: {
				aivoice: {
					default: "p",
					realizations: {
						p: {
							preset: "p",
							styles: [],
							tones: {
								neutral: tone({
									volume: 2,
									speed: 2,
									pitch: 2,
									pitch_range: 2,
									middle_pause: 2,
								}),
							},
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
		const m = toAivoiceValues(ir(), extreme)?.masterOverrides;
		expect(m).toEqual({
			Volume: 5,
			Speed: 4,
			Pitch: 2,
			PitchRange: 2,
			MiddlePause: 500,
			LongPause: 2000,
			SentencePause: 10000,
		});
		const slow: VoiceProfile = structuredClone(extreme);
		const p = slow.engines.aivoice?.realizations.p;
		if (!p) throw new Error("fixture");
		p.master = { ...p.master, speed: 0.5, pitch: 0.5 };
		p.tones = { neutral: tone({ speed: 0.5, pitch: 0.5 }) };
		const low = toAivoiceValues(ir(), slow)?.masterOverrides;
		expect(low?.Speed).toBeGreaterThanOrEqual(0.5);
		expect(low?.Pitch).toBeGreaterThanOrEqual(0.5);
	});

	it("間は整数のミリ秒にする", () => {
		const odd: VoiceProfile = structuredClone(profile);
		const real = odd.engines.aivoice?.realizations.yukari;
		if (!real) throw new Error("fixture");
		real.master = { ...master, middle_pause_ms: 200, long_pause_ms: 370.4 };
		for (const emotion of ["neutral", "anger"] as const) {
			const m = toAivoiceValues(ir({ emotion }), odd)?.masterOverrides;
			expect(Number.isInteger(m?.MiddlePause)).toBe(true);
			expect(Number.isInteger(m?.LongPause)).toBe(true);
			expect(Number.isInteger(m?.SentencePause)).toBe(true);
		}
	});
});
