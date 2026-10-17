const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 内部は UTC。表示のときだけ JST にする。 */
export const jst = (iso: string | null): string => {
	if (iso === null) return "-";
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	return new Date(t + JST_OFFSET_MS)
		.toISOString()
		.replace("T", " ")
		.slice(0, 19);
};

export const jstTime = (d: Date): string => jst(d.toISOString()).slice(11);

/** 値は 0..1（mood は -1..1）。人が読むときは割合で出す。 */
export const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** 差分は 1 ターンで数 % 程度なので、小数 1 桁まで出さないと 0% に潰れる。 */
export const signedPct = (n: number): string =>
	`${n > 0 ? "+" : ""}${+(n * 100).toFixed(1)}%`;

export const shortModel = (m: string | null): string =>
	m ? m.replace(/^claude-/, "") : "-";
