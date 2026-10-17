import type { BodyIntent, BodyState } from "@yunomi/core";
import type { GatewayResponse, InboundMessage } from "@yunomi/protocol";
import type { DecisionReason, TurnAuditData } from "../audit.ts";

export type TurnOutcome = {
	response: GatewayResponse;
	audit: TurnAuditData;
	/** 脳が身体に渡す意図。返事を送ったあと、身体が声にするかを決める。 */
	intent?: BodyIntent;
	/** 返事に添える VC の出入りの意思。 */
	voiceChannel?: "join" | "leave" | "stay";
	/** この返事を考えたときの身体の状態。 */
	bodyState?: BodyState;
};

/** onEngaged は、返事に進むと決まった時点で一度だけ呼ばれる。入力中の表示はここから始める。 */
export type Pipeline = (
	msg: InboundMessage,
	onEngaged?: () => void,
) => Promise<TurnOutcome>;

export const inboundSummary = (
	msg: InboundMessage,
): TurnAuditData["inbound"] => ({
	eventId: msg.eventId,
	messageId: msg.messageId,
	channelId: msg.channelId,
	authorId: msg.author.id,
	authorName: msg.author.displayName,
	isBot: msg.author.isBot,
	contentLength: msg.content.length,
	content: msg.content,
});

export const ignoreOutcome = (
	msg: InboundMessage,
	reason: DecisionReason,
	extra: Partial<TurnAuditData> = {},
): TurnOutcome => ({
	response: { action: "ignore" },
	audit: {
		inbound: inboundSummary(msg),
		decision: "ignore",
		reason,
		decisionSummary: null,
		model: null,
		fallbackUsed: false,
		degraded: false,
		usage: null,
		latencyMs: null,
		errorType: null,
		toolCalls: [],
		state: null,
		relationship: null,
		memory: null,
		openLoops: null,
		interestOpinion: null,
		degradedTransition: null,
		...extra,
	},
});
