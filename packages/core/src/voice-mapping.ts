import type { AivoiceValues, PacePhrase, PerformanceIR } from "./body.ts";
import type { AivoiceRealization, VoiceProfile } from "./voice-profile.ts";

const clamp = (x: number, min: number, max: number): number =>
	Math.min(max, Math.max(min, x));

const unit = (x: number): number => clamp(Number.isFinite(x) ? x : 0.5, 0, 1);

const paceFactor: Record<PacePhrase, number> = {
	slow: 0.8,
	slightly_slow: 0.9,
	normal: 1,
	slightly_fast: 1.1,
	fast: 1.2,
};

// 抑えて表す感情の言い方。聞き比べて決めた倍率。
const quiet = {
	pitchRange: 0.85,
	speed: 0.95,
	volume: 0.95,
	middlePause: 1.15,
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
 * pause_before_ms は発声の前の間なので、エンジンの値には入れず身体が扱う。
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

	const isQuiet = profile.traits.quiet_emotions.includes(ir.emotion);
	const styleEnergy = unit(ir.energy);
	// 抑える感情では、声の張りを標準より上げない。
	const energy = isQuiet ? Math.min(styleEnergy, 0.5) : styleEnergy;
	const warmth = unit(ir.warmth);
	const { master } = real;
	const q = isQuiet
		? quiet
		: { pitchRange: 1, speed: 1, volume: 1, middlePause: 1 };

	// エンジンは前回のスタイル値を保持するので、対象外のスタイルも 0 で明示して持ち越しを防ぐ。
	const names = [
		...new Set([...real.styles, ...Object.values(real.emotion_styles)]),
	];
	const active = real.emotion_styles[ir.emotion];
	const strength = unit(styleEnergy * profile.traits.expressiveness);
	const Styles = names.map((Name) => ({
		Name,
		Value: Name === active ? strength : 0,
	}));
	// スタイルを持たないプリセットには Styles を送らない。
	const presetOverrides = Styles.length > 0 ? { Styles } : {};

	return {
		engine: "aivoice",
		preset: real.preset,
		presetOverrides,
		masterOverrides: {
			Volume: clamp(master.volume * (0.9 + 0.2 * energy) * q.volume, 0, 5),
			Speed: clamp(
				master.speed *
					profile.traits.base_pace *
					paceFactor[ir.pace] *
					(0.9 + 0.2 * energy) *
					q.speed,
				0.5,
				4,
			),
			Pitch: clamp(
				master.pitch * profile.traits.base_pitch * (0.95 + 0.1 * energy),
				0.5,
				2,
			),
			PitchRange: clamp(
				master.pitch_range * (0.8 + 0.4 * energy) * q.pitchRange,
				0,
				2,
			),
			// A.I.VOICE は間に整数のミリ秒しか受け付けず、小数を送ると合成ごと失敗する。
			MiddlePause: Math.round(
				clamp(
					master.middle_pause_ms * (0.9 + 0.2 * warmth) * q.middlePause,
					80,
					500,
				),
			),
			LongPause: Math.round(clamp(master.long_pause_ms, 100, 2000)),
			SentencePause: Math.round(clamp(master.sentence_pause_ms, 0, 10000)),
		},
	};
};
