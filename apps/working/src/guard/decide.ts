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
