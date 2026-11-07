import { modelDateTime } from "@yunomi/core";
import * as v from "valibot";
import type { ToolDefinition } from "../contract.ts";

export const WATCH_QUERY_MAX_LENGTH = 200;
export const WATCH_SOURCE_MAX_LENGTH = 300;
export const WATCH_SOURCES_MAX = 5;
// Working の受付が見張りごとに Dkron のジョブを置くので、1 時間単位まで守れる。
export const WATCH_INTERVAL_MIN_HOURS = 1;
export const WATCH_INTERVAL_MAX_HOURS = 24 * 7;
export const WATCH_INTERVAL_DEFAULT_HOURS = 24;
export const WATCH_SCHEDULE_MAX_LENGTH = 100;

const oneLine = (max: number, description: string) =>
	v.pipe(
		v.string(),
		v.trim(),
		v.nonEmpty(),
		v.maxLength(max),
		v.regex(/^[^\r\n]*$/, "改行を入れない"),
		v.description(description),
	);

const watchAddInput = v.object({
	query: oneLine(
		WATCH_QUERY_MAX_LENGTH,
		"何を探すか。条件（状態、容量、値段の上限など）も 1 行に書く。例「RTX3090 の中古、24GB、10 万円以下」",
	),
	sources: v.pipe(
		v.array(
			oneLine(
				WATCH_SOURCE_MAX_LENGTH,
				"見る場所。店やサイトの名前か、在庫や検索結果のページの URL",
			),
		),
		v.maxLength(WATCH_SOURCES_MAX),
		v.description(
			`どこを見るか（${WATCH_SOURCES_MAX} 件まで）。指定がなければ空配列で、普通の検索で探す`,
		),
	),
	// 記憶の口からは項目ごと省けるよう nullish にする。道具の JSON Schema では全項目が必須になり、使わない方は null で来る。
	interval_hours: v.pipe(
		v.nullish(
			v.pipe(
				v.number(),
				v.integer(),
				v.minValue(WATCH_INTERVAL_MIN_HOURS),
				v.maxValue(WATCH_INTERVAL_MAX_HOURS),
			),
		),
		v.description(
			`何時間おきに調べるか（${WATCH_INTERVAL_MIN_HOURS} 〜 ${WATCH_INTERVAL_MAX_HOURS}）。schedule を使うときは null。どちらも null なら ${WATCH_INTERVAL_DEFAULT_HOURS} 時間おき`,
		),
	),
	schedule: v.pipe(
		v.nullish(oneLine(WATCH_SCHEDULE_MAX_LENGTH, "cron 式")),
		v.description(
			"曜日や時間帯を決めて調べるときの cron 式。5 項目（分 時 日 月 曜日）で、日本時間で読む。曜日は 0 と 7 が日曜、1-5 が平日。例「0 9-18 * * 1-5」（平日 9〜18 時の毎正時）、「*/30 9-21 * * *」（毎日 9〜21 時の 30 分おき）、「0 8,20 * * 0,6」（土日の 8 時と 20 時）。30 分より詰めた式は通らない。interval_hours を使うときは null",
		),
	),
	until: v.pipe(
		v.nullable(
			v.pipe(
				modelDateTime(),
				v.nonEmpty("タイムゾーン付きの ISO 8601 の日時で書く"),
			),
		),
		v.description(
			"いつまで見張るか。タイムゾーン付きの ISO 8601（+09:00）。期限が無ければ null",
		),
	),
});

export type WatchAddInput = v.InferOutput<typeof watchAddInput>;

export const watchAdd: ToolDefinition<WatchAddInput> = {
	name: "watch_add",
	description:
		"オーナーに頼まれた見張りを 1 件登録する。仕事の席が間隔（interval_hours）か決めた時刻（schedule）ごとに調べ、条件に合う新着だけを 1 行で知らせる。間隔と時刻はどちらか一方だけ指定する。同じ出品は二度知らせない。同じ見張りがもうあるときや、数の上限に達しているときは登録できない。",
	category: "watch_write",
	input: watchAddInput,
};

const watchStopInput = v.object({
	id: v.pipe(
		v.string(),
		v.trim(),
		v.nonEmpty(),
		v.description("「見張り」の [ ] の中の id"),
	),
});

export type WatchStopInput = v.InferOutput<typeof watchStopInput>;

export const watchStop: ToolDefinition<WatchStopInput> = {
	name: "watch_stop",
	description:
		"見張りを 1 件止める（買えた、もう要らない、など）。止めた見張りは調べなくなり、一覧から消える。",
	category: "watch_write",
	input: watchStopInput,
};
