const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** UTC の Date を JST の `YYYY-MM-DD HH:mm:ss` に整形する。表示専用で、保存には使わない。 */
export const formatJst = (date: Date): string => {
	const shifted = new Date(date.getTime() + JST_OFFSET_MS);
	return shifted.toISOString().slice(0, 19).replace("T", " ");
};
