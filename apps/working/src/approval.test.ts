import { describe, expect, it } from "vitest";
import { approvalRequestText, isApproval, uniquePending } from "./approval.ts";

const request = { messageIds: ["req1", "req2"], operations: [] };

describe("isApproval", () => {
	it.each(["OK", "ok", "ＯＫ", "OK!", "許可", "許可します。", "<@123> OK"])(
		"%s は許可",
		(content) => {
			expect(isApproval({ content, replyToMessageId: null }, request)).toBe(
				true,
			);
		},
	);

	it.each(["OKだけど待って", "いいよ", "うん", "OK? やめとく", ""])(
		"%s は許可にしない",
		(content) => {
			expect(isApproval({ content, replyToMessageId: null }, request)).toBe(
				false,
			);
		},
	);

	it("返信なら、許可を求めたメッセージへの返信だけを許可にする", () => {
		expect(
			isApproval({ content: "OK", replyToMessageId: "req2" }, request),
		).toBe(true);
		expect(
			isApproval({ content: "OK", replyToMessageId: "other" }, request),
		).toBe(false);
	});
});

describe("approvalRequestText", () => {
	it("同じ操作は 1 つにまとめ、コマンドをそのまま見せる", () => {
		const op = { tool: "Bash", target: "git push origin main" };
		const items = uniquePending([
			{ operation: op, reason: "dev/ 以外のブランチへの push" },
			{ operation: op, reason: "dev/ 以外のブランチへの push" },
			{
				operation: { tool: "Write", target: "/home/worker/.bashrc" },
				reason: "作業場所の外への書き込み",
			},
		]);
		const text = approvalRequestText(items);
		expect(text).toContain(
			"1. dev/ 以外のブランチへの push\n```\ngit push origin main\n```",
		);
		expect(text).toContain(
			"2. 作業場所の外への書き込み\n```\nWrite: /home/worker/.bashrc\n```",
		);
		expect(text).toContain("「OK」か「許可」");
	});
});
