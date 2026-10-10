import {
	PromptBuilder,
	type TurnResponse,
	toPromptMessage,
	turnOutput,
} from "@yunomi/conversation";
import {
	applyRelationshipDelta,
	applyStateDelta,
	type DomainError,
	externalServiceUnavailable,
	initialPartnerState,
	initialRelationship,
	lifestyleDay,
	newId,
	type PartnerProfile,
	type Result,
} from "@yunomi/core";
import type { ModelRouter, RoutedResult } from "@yunomi/llm";
import type { InboundMessage } from "@yunomi/protocol";
import type { TurnAuditData } from "../audit.ts";
import type { MemoryRepo } from "../memory.ts";
import type { EntityResolver } from "./entities.ts";
import type { HistoryWriter } from "./history.ts";
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
	entities: EntityResolver;
	history: HistoryWriter;
	memory: MemoryRepo;
	/** 応答経路から外す書き込み（D1 履歴）を登録する。 */
	background: (task: Promise<void>) => void;
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

	const { profile, store } = deps;
	const partnerId = profile.partner_id;
	let entityId: string;
	try {
		entityId = await deps.entities.resolve(
			"discord",
			msg.author.id,
			msg.author.displayName,
		);
	} catch {
		return degraded(
			msg,
			externalServiceUnavailable({ service: "d1:entities" }),
			0,
		);
	}

	const seededAt = deps.now();
	const state0 = store.getState() ?? seedState(deps, seededAt);
	const rel0 =
		store.getRelationship(partnerId, entityId) ??
		seedRelationship(deps, entityId, seededAt);

	// 記憶の取得に失敗しても会話は続ける（記憶なしで応答する）。
	const facts = await deps.memory.topFacts(partnerId, entityId).catch(() => []);

	const prompt = new PromptBuilder().build({
		profile,
		state: state0,
		relationship: {
			speakerName: msg.author.displayName,
			familiarity: rel0.relationship.familiarity,
			trust: rel0.relationship.trust,
		},
		memory: facts.map((f) => ({
			subject: msg.author.displayName,
			predicate: f.predicate,
			object: f.object,
		})),
		channel: { name: null, presence: null },
		recent: store.recentMessages(msg.channelId, msg.messageId).map((m) => ({
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
	// LLM の await の間に他チャンネルのターンが state を更新しうるため、最新値を読み直し、
	// await を挟まず同期で適用・保存する。LLM には絶対値を返させない。
	const at = deps.now();
	const before = store.getState() ?? state0;
	const stateUpdate = applyStateDelta(
		partnerId,
		before,
		output.emotion_delta,
		at,
	);
	if (stateUpdate.state !== before) store.putState(stateUpdate.state);
	const relBefore = store.getRelationship(partnerId, entityId) ?? rel0;
	const relUpdate = applyRelationshipDelta(
		relBefore.relationship,
		relBefore.accumulator,
		output.relationship_delta,
		at,
		profile.living_rhythm.lifestyle_day_boundary,
	);
	store.putRelationship(relUpdate.relationship, relUpdate.accumulator);

	if (stateUpdate.state !== before) {
		deps.background(
			deps.history.recordStateTransition({
				partnerId,
				before,
				after: stateUpdate.state,
				delta: stateUpdate.applied,
				sourceEventId: msg.eventId,
				occurredAt: at,
			}),
		);
	}
	if (relUpdate.applied.familiarity !== 0 || relUpdate.applied.trust !== 0) {
		deps.background(
			deps.history.recordRelationshipEvent({
				partnerId,
				entityId,
				delta: relUpdate.applied,
				summary: output.decision_summary,
				sourceEventId: msg.eventId,
				occurredAt: at,
			}),
		);
	}

	// 次のターンの prompt に載せるため、応答前に書き終える（background にしない）。
	// 失敗しても返信は止めず、audit に残す。
	let memory: NonNullable<TurnAuditData["memory"]>;
	try {
		memory = {
			outcomes: await deps.memory.processCandidates(
				{
					partnerId,
					speakerEntityId: entityId,
					speakerAliases: [msg.author.displayName, msg.author.id],
					sourceEventId: msg.eventId,
					now: at,
				},
				output.memory_candidates.map((c) => ({
					subject: c.subject,
					predicate: c.predicate,
					object: c.object,
					confidence: c.confidence,
					importance: c.importance,
					source: c.source,
				})),
			),
			error: null,
		};
	} catch (e) {
		memory = {
			outcomes: [],
			error: e instanceof Error ? e.message : "memory write failed",
		};
	}

	const common = {
		memory,
		state: { applied: stateUpdate.applied, rejected: stateUpdate.rejected },
		relationship: {
			entityId,
			applied: relUpdate.applied,
			rejected: relUpdate.rejected,
		},
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

// 初回のみ。プロファイルの初期値を DO に永続化してから使う。
const seedState = (deps: TurnDeps, now: Date) => {
	const s = initialPartnerState(deps.profile, now);
	deps.store.putState(s);
	return s;
};

const seedRelationship = (deps: TurnDeps, entityId: string, now: Date) => {
	const relationship = initialRelationship(deps.profile, entityId, now);
	const accumulator = {
		day: lifestyleDay(now, deps.profile.living_rhythm.lifestyle_day_boundary),
		familiarity: 0,
		trust: 0,
	};
	deps.store.putRelationship(relationship, accumulator);
	return { relationship, accumulator };
};
