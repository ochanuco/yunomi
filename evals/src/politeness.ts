const QUOTE_PAIRS: [string, string][] = [
	["「", "」"],
	["『", "』"],
	["“", "”"],
	["（", "）"],
	["(", ")"],
];

/** 引用・括弧内を除く。他者の発言や例示の文末は話者本人の口調ではないため。 */
export const stripQuoted = (text: string): string => {
	let out = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
	for (const [open, close] of QUOTE_PAIRS) {
		const re = new RegExp(
			`${escapeRegExp(open)}[^${escapeRegExp(open)}${escapeRegExp(close)}]*${escapeRegExp(close)}`,
			"g",
		);
		let prev: string;
		do {
			prev = out;
			out = out.replace(re, "");
		} while (out !== prev);
	}
	return out
		.split("\n")
		.filter((l) => !l.trimStart().startsWith(">"))
		.join("\n");
};

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const splitSentences = (text: string): string[] =>
	text
		.split(/[。！？!?\n]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

// 語尾の感嘆・記号・絵文字・終助詞を落としてから文末を見る。
const TRAILING_NOISE = /[\s…・~〜ー♪♡☆★、,.\p{Extended_Pictographic}]+$/u;
const FINAL_PARTICLES = /(?:ね|よ|か|な|わ)$/;

const POLITE_ENDINGS = [
	"です",
	"ます",
	"ました",
	"ません",
	"ませんでした",
	"でした",
	"でしょう",
	"ください",
	"くださいね",
	"ましょう",
	"ございます",
	"ございました",
	"いたします",
	"おります",
	"ありません",
	"ではないでしょうか",
	"ますように",
	// 敬語の言い回しで言いさす文末。
	"どうぞ",
	"お気をつけて",
	"ご注意を",
	"いただければ",
];

const NEUTRAL = new Set([
	"はい",
	"いいえ",
	"ええ",
	"こんにちは",
	"こんばんは",
	"おはようございます",
	"おやすみなさい",
	"ありがとうございます",
	"ありがとうございました",
	"お疲れさまです",
	"お疲れ様です",
	"ぜひ",
]);

// 「休みますしね」「あるくらいですから」のように丁寧語尾のあとに接続助詞で言いさす文末。
const POLITE_THEN_CONNECTIVE =
	/(?<=です|ます|ました|ません|でした|でしょう)(?:し|から|ので|けど|けれど|けれども|が)$/;

// 「おはようございます、alice さん」のように呼びかけで終わる文は、呼びかけの前の語尾で判定する。
const TRAILING_VOCATIVE = /[、,]\s*[^、,]{1,24}?(?:さん|さま|様|くん|ちゃん)$/;

const stripEnding = (sentence: string): string =>
	sentence
		.replace(TRAILING_NOISE, "")
		.replace(TRAILING_VOCATIVE, "")
		.replace(TRAILING_NOISE, "");

const normalizeEnding = (sentence: string): string => {
	let s = stripEnding(sentence);
	// 「ですね」「ますよ」など終助詞を最大 2 つまで剥がして、丁寧語尾を露出させる。
	for (let i = 0; i < 2; i++) {
		const stripped = s.replace(FINAL_PARTICLES, "");
		if (stripped === s) break;
		if (POLITE_ENDINGS.some((e) => s.endsWith(e))) break;
		s = stripped;
	}
	return s.replace(TRAILING_NOISE, "").replace(POLITE_THEN_CONNECTIVE, "");
};

export const isPoliteSentence = (sentence: string): boolean => {
	const s = normalizeEnding(sentence);
	return POLITE_ENDINGS.some((e) => s.endsWith(e));
};

// 「おはようございます、alice」のように定型句に呼びかけだけが続く文も定型句として扱う。
const isNeutral = (sentence: string): boolean => {
	const s = stripEnding(sentence);
	if (NEUTRAL.has(s)) return true;
	const parts = s.split(/[、,]/);
	const [head, tail] = parts;
	return (
		parts.length === 2 &&
		head !== undefined &&
		tail !== undefined &&
		NEUTRAL.has(head) &&
		tail.trim().length <= 24
	);
};

/** 丁寧語尾の文の割合（0〜1）。引用は除き、挨拶など語尾で判定できない短い定型句は分母に入れない。判定対象が無ければ 1。 */
export const politenessScore = (text: string): number => {
	const sentences = splitSentences(stripQuoted(text)).filter(
		(s) => !isNeutral(s),
	);
	if (sentences.length === 0) return 1;
	return sentences.filter(isPoliteSentence).length / sentences.length;
};

/** 発話の最後の文が質問で終わるか。全角・半角の疑問符か、「か」「でしょうか」で終わるもの。 */
export const endsWithQuestion = (text: string): boolean => {
	const t = stripQuoted(text).trim();
	if (t.length === 0) return false;
	if (/[？?]\s*$/.test(t)) return true;
	const last = t.replace(/[。！!]+$/, "").replace(TRAILING_NOISE, "");
	return /(か|かな|かしら)$/.test(last);
};
