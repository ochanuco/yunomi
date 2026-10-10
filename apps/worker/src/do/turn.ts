import {
	PromptBuilder,
	type TurnResponse,
	toPromptMessage,
	turnOutput,
} from "@yunomi/conversation";
import {
	type DomainError,
	externalServiceUnavailable,
	newId,
	type PartnerProfile,
	type Result,
} from "@yunomi/core";
import type { ModelRouter, RoutedResult } from "@yunomi/llm";
import type { InboundMessage } from "@yunomi/protocol";
import { ignoreOutcome, inboundSummary, type TurnOutcome } from "./pipeline.ts";
import type { DoStore } from "./store.ts";

export const CONTINUATION_WINDOW_MS = 3 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 3000;

export type TurnDeps = {
	store: DoStore;
	profile: PartnerProfile;
	partnerUserId: string;
	now: () => Date;
	createRouter: () => ModelRouter;
};

const isContinuation = (deps: TurnDeps, msg: InboundMessage): boolean => {
	const last = deps.store.lastPartnerReplyAt(msg.channelId);
	if (last && deps.now().getTime() - last.getTime() <= CONTINUATION_WINDOW_MS) {
		return true;
	}
	if (msg.replyToMessageId) {
		return deps.store.getMessage(msg.replyToMessageId)?.isPartner === true;
	}
	return false;
};

export const runTurn = async (
	deps: TurnDeps,
	msg: InboundMessage,
): Promise<TurnOutcome> => {
	if (msg.author.id === deps.partnerUserId) return ignoreOutcome(msg, "self");
	if (msg.author.isBot) return ignoreOutcome(msg, "bot");

	const mentioned = msg.mentionedUserIds.includes(deps.partnerUserId);
	if (!mentioned && !isContinuation(deps, msg)) {
		return ignoreOutcome(msg, "not_addressed");
	}

	const { profile } = deps;
	const prompt = new PromptBuilder().build({
		profile,
		state: profile.initial_state,
		relationship: {
			speakerName: msg.author.displayName,
			...profile.initial_relationship,
		},
		memory: [],
		channel: { name: null, presence: null },
		recent: deps.store
			.recentMessages(msg.channelId, msg.messageId)
			.map((m) => ({
				speaker: m.authorName,
				text: m.content,
			})),
		message: toPromptMessage(msg, deps.partnerUserId),
	});

	const started = Date.now();
	let result: Result<RoutedResult<TurnResponse>, DomainError>;
	try {
		result = await deps.createRouter().generate({
			system: prompt.system,
			messages: prompt.messages,
			output: turnOutput,
			maxTokens: MAX_OUTPUT_TOKENS,
		});
	} catch {
		result = {
			ok: false,
			error: externalServiceUnavailable({ service: "llm:unexpected" }),
		};
	}

	if (!result.ok) return degraded(msg, result.error, Date.now() - started);

	const { output, model, usage, latencyMs, fallbackUsed } = result.value;
	const common = {
		decisionSummary: output.decision_summary,
		model,
		fallbackUsed,
		usage,
		latencyMs,
		toolIntents: output.tool_intents,
	};
	const utterance = output.utterance.trim();
	if (output.reply_policy !== "reply" || utterance === "") {
		return ignoreOutcome(msg, "llm", common);
	}

	const at = deps.now();
	deps.store.setLastPartnerReplyAt(msg.channelId, at);
	// 実際の Discord message id は Gateway が送信するまで分からないため、仮の ID で文脈に残す。
	deps.store.appendRecent({
		channelId: msg.channelId,
		messageId: `partner:${newId()}`,
		authorId: deps.partnerUserId,
		authorName: profile.display_name,
		isBot: false,
		isPartner: true,
		content: utterance,
		occurredAt: at.toISOString(),
	});
	return {
		response: {
			action: "reply",
			content: utterance,
			reply_to_message_id: msg.messageId,
		},
		audit: {
			inbound: inboundSummary(msg),
			decision: "reply",
			reason: "llm",
			degraded: false,
			errorType: null,
			...common,
		},
	};
};

const degraded = (
	msg: InboundMessage,
	error: DomainError,
	latencyMs: number,
): TurnOutcome =>
	ignoreOutcome(msg, "error", {
		degraded: true,
		errorType: error.type,
		latencyMs,
	});
