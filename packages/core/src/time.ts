const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** UTC の Date を JST の `YYYY-MM-DD HH:mm:ss` に整形する。表示専用で、保存には使わない。 */
export const formatJst = (date: Date): string => {
	const shifted = new Date(date.getTime() + JST_OFFSET_MS);
	return shifted.toISOString().slice(0, 19).replace("T", " ");
};

const parseBoundary = (boundary: string): number => {
	const [h, m] = boundary.split(":").map(Number);
	return ((h ?? 0) * 60 + (m ?? 0)) * 60 * 1000;
};

/**
 * 生活日（lifestyle day）の識別子 `YYYY-MM-DD`。JST の `boundary`（既定 05:00）で日が切り替わる。
 * 例: JST 04:59 は前日、05:00 はその日の生活日。
 */
export const lifestyleDay = (date: Date, boundary = "05:00"): string =>
	new Date(date.getTime() + JST_OFFSET_MS - parseBoundary(boundary))
		.toISOString()
		.slice(0, 10);
