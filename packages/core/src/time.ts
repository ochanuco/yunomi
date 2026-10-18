import * as v from "valibot";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** UTC の Date を JST の `YYYY-MM-DD HH:mm:ss` に整形する。表示専用で、保存には使わない。 */
export const formatJst = (date: Date): string => {
	const shifted = new Date(date.getTime() + JST_OFFSET_MS);
	return shifted.toISOString().slice(0, 19).replace("T", " ");
};

/** JST の壁時計を UTC のフィールドとして読めるようにずらした Date。`getUTC*` で月・日・曜日を読む用で、時刻としては使わない。 */
export const toJstDate = (date: Date): Date =>
	new Date(date.getTime() + JST_OFFSET_MS);

/** JST の暦日の通し番号。日数の差を暦日で数えるときに使う。 */
export const jstDayNumber = (date: Date): number =>
	Math.floor((date.getTime() + JST_OFFSET_MS) / (24 * 60 * 60 * 1000));

/**
 * モデルに見せる絶対時刻の唯一の書式 `YYYY-MM-DD HH:mm JST`。UTC の ISO をそのまま渡すと、モデルが JST と取り違える。
 * 受け取るのを Date だけにして、ISO 文字列のまま prompt に入る経路を型で塞ぐ。
 */
export const formatJstForPrompt = (date: Date): string =>
	`${formatJst(date).slice(0, 16)} JST`;

const MODEL_DATETIME =
	/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * モデルが書いた日時を UTC の ISO に直す。読めなければ null。
 * オフセット（`Z` / `±HH:MM`）がなければ JST として読む。`Date.parse` は Workers では UTC として読むため、そのままだと 9 時間ずれる。
 * 日付だけ（`2026-10-18`）は JST の 0 時。
 */
export const parseModelDateTime = (value: string): string | null => {
	const m = MODEL_DATETIME.exec(value.trim());
	if (m === null) return null;
	const [, date, time = "00:00", offset = "+09:00"] = m;
	const zone = /^[+-]\d{4}$/.test(offset)
		? `${offset.slice(0, 3)}:${offset.slice(3)}`
		: offset.toUpperCase();
	const t = Date.parse(`${date}T${time}${zone}`);
	return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/**
 * モデルに渡す JSON の唯一の直列化。Date だけを `formatJstForPrompt` にし、文字列には触れない。
 * `JSON.stringify` は replacer の前に `toJSON` を呼ぶので、元の値は `this[key]` から読む。
 * 読めない Date は `JSON.stringify` の既定どおり null にする。
 */
export const toModelJson = (value: unknown): string =>
	JSON.stringify(value, function (this: Record<string, unknown>, key, current) {
		const original = this[key];
		if (!(original instanceof Date)) return current;
		return Number.isNaN(original.getTime())
			? null
			: formatJstForPrompt(original);
	});

/** 読めない日時の値。後段の `Date.parse` が NaN にするので、受け取った側は日時として捨てる。 */
const UNREADABLE_DATETIME = "";

/** `parseModelDateTime` の結果を、読めなければ空文字にして文字列のまま返す。memory の object.value のように型を保つ場所向け。 */
export const readModelDateTime = (value: string): string =>
	parseModelDateTime(value) ?? UNREADABLE_DATETIME;

/**
 * モデルが書いた日時の境界用 codec。出力は UTC の ISO で、オフセットの無い値は JST として読む。
 * 読めない値でも検証は失敗させず空文字にする。1 つの日時が壊れていても応答全体を捨てず、後段が該当の項目だけ捨てる。
 */
export const modelDateTime = () =>
	v.pipe(v.string(), v.transform(readModelDateTime));

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
