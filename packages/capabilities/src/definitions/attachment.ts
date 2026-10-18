import * as v from "valibot";
import type { ToolDefinition } from "../contract.ts";

const readAttachmentInput = v.object({
	message: v.pipe(
		v.picklist(["current", "reply"]),
		v.description(
			"どのメッセージの添付か。current はいま届いたメッセージ、reply は返信先のメッセージ",
		),
	),
	index: v.pipe(
		v.number(),
		v.integer(),
		v.minValue(1),
		v.maxValue(10),
		v.description("添付の番号（1 始まり）。「添付」の一覧の番号に合わせる"),
	),
});

export type ReadAttachmentInput = v.InferOutput<typeof readAttachmentInput>;

export const readAttachment: ToolDefinition<ReadAttachmentInput> = {
	name: "read_attachment",
	description:
		"Discord のメッセージに付いた添付ファイルの中身を読む。読めるのは画像（jpeg・png・gif・webp）とテキストファイル。PDF など、ほかの形式は読めない。相手が「これ読んで」「この画像見て」のように中身を見るよう明示したときだけ呼ぶ。",
	category: "attachment_read",
	input: readAttachmentInput,
};
