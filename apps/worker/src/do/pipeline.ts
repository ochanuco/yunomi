import type { GatewayResponse, InboundMessage } from "@yunomi/protocol";
import type { DecisionReason, TurnAuditData } from "../audit.ts";

export type TurnOutcome = {
	response: GatewayResponse;
	audit: TurnAuditData;
};

export type Pipeline = (msg: InboundMessage) => Promise<TurnOutcome>;

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
		toolIntents: [],
		state: null,
		relationship: null,
		memory: null,
		...extra,
	},
});
