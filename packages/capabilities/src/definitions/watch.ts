import { modelDateTime } from "@yunomi/core";
import * as v from "valibot";
import type { ToolDefinition } from "../contract.ts";

export const WATCH_QUERY_MAX_LENGTH = 200;
export const WATCH_SOURCE_MAX_LENGTH = 300;
export const WATCH_SOURCES_MAX = 5;
// 見回りは 2 時間おきなので、それより短い間隔は守れない。
export const WATCH_INTERVAL_MIN_HOURS = 2;
export const WATCH_INTERVAL_MAX_HOURS = 24 * 7;

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
	interval_hours: v.pipe(
		v.number(),
		v.integer(),
		v.minValue(WATCH_INTERVAL_MIN_HOURS),
		v.maxValue(WATCH_INTERVAL_MAX_HOURS),
		v.description(
			`何時間おきに調べるか（${WATCH_INTERVAL_MIN_HOURS} 〜 ${WATCH_INTERVAL_MAX_HOURS}）。指定がなければ 24`,
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
		"オーナーに頼まれた見張りを 1 件登録する。仕事の席の見回りが間隔ごとに調べ、条件に合う新着だけを 1 行で知らせる。同じ出品は二度知らせない。同じ見張りがもうあるときや、数の上限に達しているときは登録できない。",
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
