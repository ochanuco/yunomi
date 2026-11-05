// hook として node で直接動かすため、node の組み込み以外を import しない。
import { classifyBash, type GuardContext } from "./bash.ts";
import type { Ledger } from "./ledger.ts";
import {
	isUnder,
	type Operation,
	operationOf,
	sameOperation,
} from "./operation.ts";

const READERS = new Set(["Read", "Glob", "Grep"]);
/** 道具の説明を読み込むだけの道具。 */
const LOADERS = new Set(["ToolSearch"]);

/**
 * MCP の道具の名前に入っていたら止める動詞。取り消せない操作と、外に届く操作。
 * 読み取りと生成（下書きや画像を作るなど）は、ほかの道具と同じく聞かずに通す。
 */
const MCP_STOP_WORDS = new Set([
	"send",
	"reply",
	"forward",
	"respond",
	"post",
	"publish",
	"deploy",
	"release",
	"share",
	"invite",
	"delete",
	"trash",
	"remove",
	"destroy",
	"purge",
	"drop",
	"revoke",
	"transfer",
	"merge",
	"execute",
	"exec",
]);

const classifyMcp = (tool: string): string | null => {
	// mcp__<サーバー>__<道具>。サーバー名ではなく道具の名前の動詞で決める
	const name = tool.split("__").slice(2).join("__");
	const words = name.toLowerCase().split(/[^a-z0-9]+/);
	const hit = words.find((w) => MCP_STOP_WORDS.has(w));
	return hit === undefined
		? null
		: `取り消せないか外に届く MCP の操作（${hit}）`;
};

const WRITERS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** 聞かずに実行してよいかを、道具ごとに調べる。止めるときは理由を返す。 */
export const classify = (op: Operation, ctx: GuardContext): string | null => {
	if (op.tool === "Bash") return classifyBash(op.target, ctx);
	if (READERS.has(op.tool)) {
		const path =
			op.tool === "Read" ? op.target : (op.target.split(" ")[0] ?? "");
		return ctx.protectedDirs.some((d) => isUnder(path, d) || isUnder(d, path))
			? "秘密情報や設定・許可の記録がある場所に触る"
			: null;
	}
	if (WRITERS.has(op.tool)) {
		return isUnder(op.target, ctx.workDir) && op.target !== ctx.workDir
			? null
			: "作業場所の外への書き込み";
	}
	if (LOADERS.has(op.tool)) return null;
	if (op.tool.startsWith("mcp__")) return classifyMcp(op.tool);
	return `${op.tool} は聞かずに使える道具に入っていない`;
};

export type HookInput = {
	tool_name: string;
	tool_input: Record<string, unknown>;
	cwd?: string;
};

export type GuardRun = {
	ctx: GuardContext;
	/** 受付がこの作業に付けた投稿の ID。止めた操作をこの投稿に紐づける。 */
	threadId: string;
	/** 持ち主が許可した操作。1 つにつき 1 回だけ通す。 */
	grants: readonly Operation[];
	grantId: string | null;
};

export type Decision =
	| { decision: "allow"; reason: string }
	| { decision: "deny"; reason: string };

const denyText = (reason: string) =>
	`この操作は持ち主の許可が要るので止めた（${reason}）。別の書き方や別の道具で同じことをしない。` +
	"orca orchestration ask で、この操作が何のために要るかを短く書いて許可を求める。受付がこの操作をそのまま「決めてほしいこと」として質問に書き添える。朝会では聞かずに、決めてほしいことに入れる。";

export const decide = (
	input: HookInput,
	run: GuardRun,
	ledger: Ledger,
): Decision => {
	const op = operationOf(
		input.tool_name,
		input.tool_input,
		input.cwd ?? run.ctx.workDir,
		run.ctx.home,
	);
	const reason = classify(op, run.ctx);
	if (reason === null)
		return { decision: "allow", reason: "聞かずに実行してよい操作" };

	if (run.grantId !== null) {
		const granted = run.grants.filter((g) => sameOperation(g, op)).length;
		const used = ledger
			.used(run.grantId)
			.filter((g) => sameOperation(g, op)).length;
		if (used < granted) {
			ledger.markUsed(run.grantId, op);
			ledger.log({
				event: "used",
				thread_id: run.threadId,
				grant_id: run.grantId,
				operation: op,
			});
			return { decision: "allow", reason: "持ち主が 1 回だけ許可した操作" };
		}
	}
	ledger.addPending(run.threadId, { operation: op, reason });
	ledger.log({
		event: "blocked",
		thread_id: run.threadId,
		operation: op,
		reason,
	});
	return { decision: "deny", reason: denyText(reason) };
};
