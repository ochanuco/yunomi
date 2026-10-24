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

// master に掛ける倍率。1 が標準。
const factor = v.optional(
	v.pipe(v.number(), v.minValue(0.5), v.maxValue(2)),
	1,
);

// 1 つの感情の声。感情ごとに 1 つだけ持ち、強弱で揺らさない。
const aivoiceToneSchema = v.object({
	// 強めるスタイル。省くとどのスタイルも 0 にする。
	style: v.optional(styleName),
	strength: v.optional(unit, 0),
	volume: factor,
	speed: factor,
	pitch: factor,
	pitch_range: factor,
	middle_pause: factor,
});

const tone = v.optional(aivoiceToneSchema);

export const aivoiceRealizationSchema = v.pipe(
	v.object({
		preset: v.pipe(v.string(), v.nonEmpty()),
		// プリセットが持つスタイルの一覧。使わないスタイルも 0 で送り、前回の値の持ち越しを防ぐ。
		// 空なら Styles を送らない（スタイルを持たないプリセット用）。
		styles: v.optional(v.array(styleName), []),
		// 載っていない感情は、スタイルなし・倍率 1 で読む。
		tones: v.optional(
			v.object({
				neutral: tone,
				joy: tone,
				amused: tone,
				anger: tone,
				sorrow: tone,
				surprised: tone,
			}),
			{},
		),
		master: aivoiceMasterSchema,
	}),
	v.check(
		(r) =>
			Object.values(r.tones).every(
				(t) => t?.style === undefined || r.styles.includes(t.style),
			),
		"tones の style が styles にない",
	),
);

export const aivoiceEngineSchema = v.pipe(
	v.object({
		// 環境が選ばなかった、または未知の名前を選んだときに使う実現方法の名前。
		default: v.pipe(v.string(), v.nonEmpty()),
		realizations: v.pipe(
			v.record(v.string(), aivoiceRealizationSchema),
			v.check((r) => Object.keys(r).length > 0, "実現方法が 1 つもない"),
		),
	}),
	v.forward(
		v.check(
			(e) => e.default in e.realizations,
			"default が realizations にない",
		),
		["default"],
	),
);

export const voiceProfileSchema = v.object({
	engines: v.object({
		aivoice: v.optional(aivoiceEngineSchema),
	}),
});

export type AivoiceTone = v.InferOutput<typeof aivoiceToneSchema>;
export type AivoiceRealization = v.InferOutput<typeof aivoiceRealizationSchema>;
export type AivoiceEngine = v.InferOutput<typeof aivoiceEngineSchema>;
export type VoiceProfile = v.InferOutput<typeof voiceProfileSchema>;
