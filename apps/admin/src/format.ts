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

export const num = (n: number): string => n.toFixed(2);

export const shortModel = (m: string | null): string =>
	m ? m.replace(/^claude-/, "") : "-";
