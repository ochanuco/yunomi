import type { ToolCallRecord } from "@yunomi/capabilities";
import type {
	PerformanceEmotion,
	RelationshipDelta,
	RelationshipUpdateRejected,
	StateDelta,
} from "@yunomi/core";
import type { Usage } from "@yunomi/llm";
import type { InterestOpinionOutcome } from "./interest-opinion.ts";
import type { CandidateOutcome } from "./memory.ts";
import type { OpenLoopOutcome } from "./open-loops.ts";

export type DecisionReason =
	| "llm"
	| "bot"
	| "not_addressed"
	| "addressed_to_other"
	| "interjection_cooldown"
	| "gate_rejected"
	| "gate_failed"
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
	/** このターンで gate を通した道具の呼び出し。道具を持たない経路では空。 */
	toolCalls: ToolCallRecord[];
	/** applied は clamp 後に実際に反映した変化量。rejected は異常値として棄却した提案。 */
	state: { applied: StateDelta; rejected: RelationshipUpdateRejected[] } | null;
	relationship: {
		entityId: string;
		applied: RelationshipDelta;
		rejected: RelationshipUpdateRejected[];
	} | null;
	memory: { outcomes: CandidateOutcome[]; error: string | null } | null;
	/** reply ターンだけ。追加・解決した Open Loop の id と、追加しなかった理由。 */
	openLoops: {
		added: string[];
		resolved: string[];
		rejected: OpenLoopOutcome["rejected"][number]["reason"][];
		error: string | null;
	} | null;
	/** reply ターンだけ。適用した変化と、適用しなかったシグナルの理由。 */
	interestOpinion: (InterestOpinionOutcome & { error: string | null }) | null;
	/** reply ターンだけ。showFace はモデルが返した生の値（欠けたら null）、avatar は表情画像の指示を実際に出したか。 */
	face: {
		emotion: PerformanceEmotion;
		showFace: boolean | null;
		avatar: boolean;
	} | null;
	/** このターンで degradedMode が切り替わったとき。LLM 失敗の連続による遷移だけを示す。 */
	degradedTransition: "entered" | "recovered" | null;
};
