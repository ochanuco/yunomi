import type { AivoiceValues, PerformanceIR } from "./body.ts";
import type {
	AivoiceRealization,
	AivoiceTone,
	VoiceProfile,
} from "./voice-profile.ts";

const clamp = (x: number, min: number, max: number): number =>
	Math.min(max, Math.max(min, x));

const plainTone: AivoiceTone = {
	strength: 0,
	volume: 1,
	speed: 1,
	pitch: 1,
	pitch_range: 1,
	middle_pause: 1,
};

export type ResolvedRealization = {
	name: string;
	realization: AivoiceRealization;
	/** 指定された名前がなく default に戻したとき true。 */
	fellBack: boolean;
};

/** 環境が選んだ名前の実現方法を返す。名前がない、または未知なら default にする。 */
export const resolveAivoiceRealization = (
	profile: VoiceProfile,
	selected?: string,
): ResolvedRealization | undefined => {
	const engine = profile.engines.aivoice;
	if (!engine) return undefined;
	const pick = (name: string) => engine.realizations[name];
	const chosen = selected ? pick(selected) : undefined;
	if (selected && chosen) {
		return { name: selected, realization: chosen, fellBack: false };
	}
	const fallback = pick(engine.default);
	if (!fallback) return undefined;
	return {
		name: engine.default,
		realization: fallback,
		fellBack: selected !== undefined && selected !== "",
	};
};

/**
 * IR と声の性質から A.I.VOICE の値を作る。同じ入力なら同じ値になる。
 * IR は感情だけを運び、声は感情ごとに 1 つのトーンで決める。調整する組み合わせを感情の数に抑えるため。
 * 声の性質に A.I.VOICE の実現方法がなければ undefined を返す。
 * realizationName は環境が選ぶ実現方法の名前で、未指定や未知の名前は default になる。
 */
export const toAivoiceValues = (
	ir: PerformanceIR,
	profile: VoiceProfile,
	realizationName?: string,
): AivoiceValues | undefined => {
	const real = resolveAivoiceRealization(profile, realizationName)?.realization;
	if (!real) return undefined;

	const tone = real.tones[ir.emotion] ?? plainTone;
	const { master } = real;

	const Styles = real.styles.map((Name) => ({
		Name,
		Value: Name === tone.style ? tone.strength : 0,
	}));
	// スタイルを持たないプリセットには Styles を送らない。
	const presetOverrides = Styles.length > 0 ? { Styles } : {};

	return {
		engine: "aivoice",
		preset: real.preset,
		presetOverrides,
		masterOverrides: {
			Volume: clamp(master.volume * tone.volume, 0, 5),
			Speed: clamp(
				master.speed * profile.traits.base_pace * tone.speed,
				0.5,
				4,
			),
			Pitch: clamp(
				master.pitch * profile.traits.base_pitch * tone.pitch,
				0.5,
				2,
			),
			PitchRange: clamp(master.pitch_range * tone.pitch_range, 0, 2),
			// A.I.VOICE は間に整数のミリ秒しか受け付けず、小数を送ると合成ごと失敗する。
			MiddlePause: Math.round(
				clamp(master.middle_pause_ms * tone.middle_pause, 80, 500),
			),
			LongPause: Math.round(clamp(master.long_pause_ms, 100, 2000)),
			SentencePause: Math.round(clamp(master.sentence_pause_ms, 0, 10000)),
		},
	};
};
