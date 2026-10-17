import * as v from "valibot";
import type { ToolDefinition } from "../contract.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LIST_SPAN_MS = 31 * DAY_MS;

// 月・時・分などの範囲まで正規表現で絞る。Date.parse は 2 月 31 日や 24:00:00 を受け付けてしまうため、
// 実在する日付かどうかは parseOffsetDateTime で確かめる。
const OFFSET_DATE_TIME =
	/^[1-9]\d{3}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** タイムゾーン付きの ISO 8601 日時を epoch ms にする。形式か日付が不正なら null。 */
const parseOffsetDateTime = (s: string): number | null => {
	if (!OFFSET_DATE_TIME.test(s)) return null;
	const year = Number(s.slice(0, 4));
	const month = Number(s.slice(5, 7));
	const day = Number(s.slice(8, 10));
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		return null;
	}
	const ms = Date.parse(s);
	return Number.isNaN(ms) ? null : ms;
};

// object の検証は日時フィールドが不正でも後続の check を走らせる。不正な日時の issue は
// 各フィールドで出ているので、ここでは比べずに通して、前後関係の issue を重ねない。
const compare = (
	a: string,
	b: string,
	holds: (aMs: number, bMs: number) => boolean,
): boolean => {
	const aMs = parseOffsetDateTime(a);
	const bMs = parseOffsetDateTime(b);
	return aMs === null || bMs === null || holds(aMs, bMs);
};

const offsetDateTime = (label: string) =>
	v.pipe(
		v.string(),
		v.check(
			(s) => parseOffsetDateTime(s) !== null,
			"タイムゾーン付きの ISO 8601 の日時ではない（例 2026-10-18T00:00:00+09:00）",
		),
		v.description(
			`${label}。タイムゾーン付きの ISO 8601（例 2026-10-18T00:00:00+09:00）`,
		),
	);

const listEventsInput = v.pipe(
	v.object({
		from: offsetDateTime("期間の開始"),
		to: offsetDateTime("期間の終了"),
	}),
	v.forward(
		v.check(
			({ from, to }) => compare(from, to, (f, t) => f < t),
			"to は from より後の日時にする",
		),
		["to"],
	),
	v.forward(
		v.check(
			({ from, to }) => compare(from, to, (f, t) => t - f <= MAX_LIST_SPAN_MS),
			"期間は 31 日以内にする",
		),
		["to"],
	),
);

const createEventInput = v.pipe(
	v.object({
		summary: v.pipe(
			v.string(),
			v.check((s) => s.trim() !== "", "予定のタイトルが空になっている"),
			v.maxLength(200),
			v.description("予定のタイトル"),
		),
		start: offsetDateTime("予定の開始"),
		end: offsetDateTime("予定の終了"),
		description: v.pipe(
			v.nullable(v.pipe(v.string(), v.maxLength(2000))),
			v.description("予定の説明。不要なら null"),
		),
	}),
	v.forward(
		v.check(
			({ start, end }) => compare(start, end, (s, e) => s < e),
			"end は start より後の日時にする",
		),
		["end"],
	),
);

export type CalendarListEventsInput = v.InferOutput<typeof listEventsInput>;
export type CalendarCreateEventInput = v.InferOutput<typeof createEventInput>;

export const calendarListEvents: ToolDefinition<CalendarListEventsInput> = {
	name: "calendar_list_events",
	description:
		"オーナーの Google カレンダーから、指定した期間の予定の一覧を取得する。期間は 31 日以内。",
	category: "calendar_read",
	input: listEventsInput,
};

export const calendarCreateEvent: ToolDefinition<CalendarCreateEventInput> = {
	name: "calendar_create_event",
	description:
		"オーナーの Google カレンダーに予定を 1 件登録する。登録はオーナーの了承を得てから実行される。",
	category: "calendar_write",
	input: createEventInput,
};
