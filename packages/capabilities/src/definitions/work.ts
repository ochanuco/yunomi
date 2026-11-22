import * as v from "valibot";
import type { ToolDefinition } from "../contract.ts";

// mizuya の受け箱（POST /working/requests）の上限に合わせる。
export const WORK_REQUEST_TITLE_MAX_LENGTH = 100;
export const WORK_REQUEST_BODY_MAX_LENGTH = 2_000;

const workRequestInput = v.object({
	title: v.pipe(
		v.string(),
		v.trim(),
		v.nonEmpty(),
		v.maxLength(WORK_REQUEST_TITLE_MAX_LENGTH),
		// 仕事フォーラムの投稿の件名になるため、改行を入れない。
		v.regex(/^[^\r\n]*$/, "改行を入れない"),
		v.description(
			`仕事の件名を 1 行で（${WORK_REQUEST_TITLE_MAX_LENGTH} 字以内）。何の仕事か一目でわかる形にする`,
		),
	),
	request: v.pipe(
		v.string(),
		v.trim(),
		v.nonEmpty(),
		v.maxLength(WORK_REQUEST_BODY_MAX_LENGTH),
		v.description(
			`依頼の本文（${WORK_REQUEST_BODY_MAX_LENGTH} 字以内）。仕事の席はこの会話を読めないので、これだけで分かるように書く。何をするか、どこでするか（repo やファイルなど、分かっていれば）、何ができたら終わりか`,
		),
	),
});

export type WorkRequestInput = v.InferOutput<typeof workRequestInput>;

export const workRequest: ToolDefinition<WorkRequestInput> = {
	name: "work_request",
	description:
		"オーナーに頼まれた仕事を、仕事の席（Working）に渡す。呼ぶとまず確認待ちになり、オーナーが了承してから渡す。渡した仕事の結果はこの会話では待たず、あとで「今の仕事」に出る。",
	category: "work_request",
	input: workRequestInput,
	ownerOnly: true,
};
