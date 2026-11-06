import * as v from "valibot";
import type { ToolDefinition } from "../contract.ts";

/** Worker の WORK_NOTE_SUMMARY_MAX_LENGTH と揃える。 */
export const GOAL_SUMMARY_MAX_LENGTH = 200;

const goalAddInput = v.object({
	summary: v.pipe(
		v.string(),
		v.trim(),
		v.nonEmpty(),
		v.maxLength(GOAL_SUMMARY_MAX_LENGTH),
		// 記憶では 1 件が 1 行に並ぶため、改行を入れると前後の行と混ざる。
		v.regex(/^[^\r\n]*$/, "改行を入れない"),
		v.description(
			`目標を 1 行で（${GOAL_SUMMARY_MAX_LENGTH} 字以内）。何をどこまで、がわかる形にする`,
		),
	),
});

export type GoalAddInput = v.InferOutput<typeof goalAddInput>;

export const goalAdd: ToolDefinition<GoalAddInput> = {
	name: "goal_add",
	description:
		"オーナーの目標を 1 件覚える。覚えた目標は会話と仕事の席の両方で読まれ、仕事の席は目標に効く提案をすることがある。同じ目標がもうあるときや、数の上限に達しているときは覚えられない。",
	category: "goal_write",
	input: goalAddInput,
};

const goalCloseInput = v.object({
	id: v.pipe(
		v.string(),
		v.trim(),
		v.nonEmpty(),
		v.description("「オーナーの目標」の [ ] の中の id"),
	),
	status: v.pipe(
		v.picklist(["achieved", "dropped"]),
		v.description("achieved は達成した、dropped は取り下げた"),
	),
});

export type GoalCloseInput = v.InferOutput<typeof goalCloseInput>;

export const goalClose: ToolDefinition<GoalCloseInput> = {
	name: "goal_close",
	description:
		"オーナーの目標を 1 件閉じる（達成した、または取り下げた）。閉じた目標は一覧から消える。",
	category: "goal_write",
	input: goalCloseInput,
};
