import type {
	RelationshipDelta,
	RelationshipUpdateRejected,
	StateDelta,
} from "@yunomi/core";
import type { Usage } from "@yunomi/llm";
import type { CandidateOutcome } from "./memory.ts";

export type DecisionReason =
	| "llm"
	| "bot"
	| "not_addressed"
	| "coalesced"
	| "self"
	| "error";

/**
 * 1 ターンの判断記録。D1 の audit_events へは audit-store.ts が書く。
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
	/** applied は clamp 後に実際に反映した変化量。rejected は異常値として棄却した提案。 */
	state: { applied: StateDelta; rejected: RelationshipUpdateRejected[] } | null;
	relationship: {
		entityId: string;
		applied: RelationshipDelta;
		rejected: RelationshipUpdateRejected[];
	} | null;
	memory: { outcomes: CandidateOutcome[]; error: string | null } | null;
};
