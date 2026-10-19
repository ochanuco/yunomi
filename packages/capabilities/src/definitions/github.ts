import * as v from "valibot";
import type { ToolDefinition } from "../contract.ts";

// owner は英数字とハイフン、repo は英数字と . _ -。"." と ".." は repo 名にならない。
export const GITHUB_REPO_PATTERN =
	/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

const githubReadInput = v.object({
	repo: v.optional(
		v.pipe(
			v.string(),
			v.trim(),
			v.regex(GITHUB_REPO_PATTERN, "owner/name の形で書く"),
			v.description("owner/name 形式のリポジトリ。省略すると既定の repo"),
		),
	),
	number: v.pipe(
		v.number(),
		v.integer(),
		v.minValue(1),
		v.description("Issue または PR の番号"),
	),
});

export type GithubReadInput = v.InferOutput<typeof githubReadInput>;

export const githubRead: ToolDefinition<GithubReadInput> = {
	name: "github_read",
	description:
		"GitHub の Issue または PR を番号で 1 件読む。種類、タイトル、状態（open / closed / merged）、ラベル、作成者、作成・更新日時、本文の冒頭、コメント数が分かる。コメントの本文や差分は分からない。",
	category: "github_read",
	input: githubReadInput,
};
