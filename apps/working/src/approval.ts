import { formatJstForPrompt } from "@yunomi/core";
import type { ApprovalRequest } from "./approval-store.ts";
import type { Pending } from "./guard/ledger.ts";
import { type Operation, sameOperation } from "./guard/operation.ts";

/** 許可の返事として受け付ける言い方。あいまいな返事で取り消せない操作を通さないよう、これだけにする。 */
const APPROVAL_WORDS = new Set(["ok", "許可", "許可します"]);

const MENTION = /<@[!&]?\d+>/g;

/**
 * 持ち主の発言が、待っている操作への許可かどうか。決まった言い方だけを許可とみなす。
 * 返信の形で送られたときは、許可を求めたメッセージへの返信でなければ許可としない。
 */
export const isApproval = (
	message: { content: string; replyToMessageId: string | null },
	request: ApprovalRequest,
): boolean => {
	const word = message.content
		.replace(MENTION, "")
		.normalize("NFKC")
		.trim()
		.replace(/[。.!！]+$/, "")
		.toLowerCase();
	if (!APPROVAL_WORDS.has(word)) return false;
	return (
		message.replyToMessageId === null ||
		request.messageIds.includes(message.replyToMessageId)
	);
};

/** 同じ操作が何度止められても 1 つにまとめる。 */
export const uniquePending = (items: readonly Pending[]): Pending[] => {
	const out: Pending[] = [];
	for (const p of items) {
		if (!out.some((q) => sameOperation(q.operation, p.operation))) out.push(p);
	}
	return out;
};

const fence = (text: string) => {
	const ticks = text.includes("```") ? "````" : "```";
	return `${ticks}\n${text}\n${ticks}`;
};

const describe = (op: Operation) =>
	op.tool === "Bash" ? fence(op.target) : fence(`${op.tool}: ${op.target}`);

/** 止めた操作を持ち主に見せ、許可を求めるメッセージ。 */
export const approvalRequestText = (items: readonly Pending[]) => {
	const list = items
		.map((p, i) => `${i + 1}. ${p.reason}\n${describe(p.operation)}`)
		.join("\n");
	return `決めてほしいこと: 次の操作は取り消せないか外に出るので、止めています。

${list}

実行してよければ、この投稿に「OK」か「許可」とだけ返事してください。書いてある操作を 1 回だけ実行します。ほかの返事をすると取りやめます。`;
};

/** 許可したあと、Claude CLI に続きをさせる指示。 */
export const approvedNote = (operations: readonly Operation[]) =>
	`持ち主が、止められていた次の操作を 1 回だけ許可した。書いてあるとおり一字一句同じ内容で実行し、作業を続ける。同じ操作をもう一度するときは、また許可が要る。

${operations.map((op, i) => `${i + 1}.\n${describe(op)}`).join("\n")}`;

export const approvedPrompt = (input: {
	now: Date;
	authorName: string;
	content: string;
	operations: readonly Operation[];
}) => `いま: ${formatJstForPrompt(input.now)}
${input.authorName}: ${input.content}

${approvedNote(input.operations)}`;
