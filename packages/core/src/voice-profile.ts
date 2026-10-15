import * as v from "valibot";

const unit = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

export const performanceEmotions = [
	"neutral",
	"joy",
	"amused",
	"anger",
	"sorrow",
	"surprised",
] as const;
export type PerformanceEmotion = (typeof performanceEmotions)[number];

const styleName = v.pipe(v.string(), v.nonEmpty());

const aivoiceMasterSchema = v.object({
	volume: v.pipe(v.number(), v.minValue(0), v.maxValue(5)),
	speed: v.pipe(v.number(), v.minValue(0.5), v.maxValue(4)),
	pitch: v.pipe(v.number(), v.minValue(0.5), v.maxValue(2)),
	pitch_range: v.pipe(v.number(), v.minValue(0), v.maxValue(2)),
	middle_pause_ms: v.pipe(v.number(), v.minValue(80), v.maxValue(500)),
	long_pause_ms: v.pipe(v.number(), v.minValue(100), v.maxValue(2000)),
	sentence_pause_ms: v.pipe(v.number(), v.minValue(0), v.maxValue(10000)),
});

export const aivoiceRealizationSchema = v.object({
	preset: v.pipe(v.string(), v.nonEmpty()),
	// 感情ごとに強めるスタイル名。載っていない感情はスタイルを動かさない。
	emotion_styles: v.partial(
		v.object({
			neutral: styleName,
			joy: styleName,
			amused: styleName,
			anger: styleName,
			sorrow: styleName,
			surprised: styleName,
		}),
	),
	master: aivoiceMasterSchema,
});

export const voiceProfileSchema = v.object({
	traits: v.object({
		// 1 が標準。マスター値の基準に掛ける倍率。
		base_pace: v.pipe(v.number(), v.minValue(0.5), v.maxValue(2)),
		base_pitch: v.pipe(v.number(), v.minValue(0.5), v.maxValue(2)),
		// 感情がどれだけ声に出やすいか。
		expressiveness: unit,
	}),
	engines: v.object({
		aivoice: v.optional(aivoiceRealizationSchema),
	}),
});

export type AivoiceRealization = v.InferOutput<typeof aivoiceRealizationSchema>;
export type VoiceProfile = v.InferOutput<typeof voiceProfileSchema>;
