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
]);

const normalizeEnding = (sentence: string): string => {
	let s = sentence.replace(TRAILING_NOISE, "");
	// 「ですね」「ますよ」など終助詞を最大 2 つまで剥がして、丁寧語尾を露出させる。
	for (let i = 0; i < 2; i++) {
		const stripped = s.replace(FINAL_PARTICLES, "");
		if (stripped === s) break;
		if (POLITE_ENDINGS.some((e) => s.endsWith(e))) break;
		s = stripped;
	}
	return s.replace(TRAILING_NOISE, "");
};

export const isPoliteSentence = (sentence: string): boolean => {
	const s = normalizeEnding(sentence);
	return POLITE_ENDINGS.some((e) => s.endsWith(e));
};

/** 丁寧語尾の文の割合（0〜1）。引用は除き、挨拶など語尾で判定できない短い定型句は分母に入れない。判定対象が無ければ 1。 */
export const politenessScore = (text: string): number => {
	const sentences = splitSentences(stripQuoted(text)).filter(
		(s) => !NEUTRAL.has(s.replace(TRAILING_NOISE, "")),
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
