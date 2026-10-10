import type { Usage } from "@yunomi/llm";

export type DecisionReason =
	| "llm"
	| "bot"
	| "not_addressed"
	| "coalesced"
	| "self"
	| "error";

/**
 * 1 ターンの判断記録。永続化は Audit Issue (#22) で行い、ここでは返り値として運ぶだけ。
 * 思考過程は持たない。判断の運用サマリ（decisionSummary）のみ。
 */
export type TurnAuditData = {
	inbound: {
		eventId: string;
		messageId: string;
		channelId: string;
		authorId: string;
		authorName: string;
		isBot: boolean;
		contentLength: number;
		content: string;
	};
	decision: "reply" | "ignore";
	reason: DecisionReason;
	decisionSummary: string | null;
	model: string | null;
	fallbackUsed: boolean;
	degraded: boolean;
	usage: Usage | null;
	latencyMs: number | null;
	errorType: string | null;
	/** MVP では実行せず記録だけ残す（他ユーザーからの指示注入対策）。 */
	toolIntents: { name: string; summary: string }[];
};
