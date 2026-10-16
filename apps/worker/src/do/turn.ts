import {
	buildGatePrompt,
	type GateDecision,
	gateOutput,
	PromptBuilder,
	type TurnResponse,
	toBodyIntent,
	toPromptMessage,
	turnOutput,
} from "@yunomi/conversation";
import {
	applyLlmFailure,
	applyLlmSuccess,
	applyRelationshipDelta,
	applyStateDelta,
	type BodyState,
	type DomainError,
	externalServiceUnavailable,
	initialPartnerState,
	initialRelationship,
	type LlmHealthUpdate,
	lifestyleDay,
	newId,
	type PartnerProfile,
	type PartnerState,
	type Result,
	resolveInterests,
	resolveOpinions,
} from "@yunomi/core";
import { HAIKU, type ModelRouter, type RoutedResult } from "@yunomi/llm";
import type { InboundMessage } from "@yunomi/protocol";
import type { TurnAuditData } from "../audit.ts";
import type { InterestOpinionRepo } from "../interest-opinion.ts";
import type { MemoryRepo } from "../memory.ts";
import type { OpenLoopRepo } from "../open-loops.ts";
import type { EntityResolver } from "./entities.ts";
import type { HistoryWriter } from "./history.ts";
import { ignoreOutcome, inboundSummary, type TurnOutcome } from "./pipeline.ts";
import type { DoStore } from "./store.ts";

export const CONTINUATION_WINDOW_MS = 3 * 60 * 1000;
/** 枠の外から割り込んで返事したあと、同じチャンネルで次に割り込まない間隔。 */
export const INTERJECTION_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_OUTPUT_TOKENS = 3000;
const GATE_MAX_OUTPUT_TOKENS = 300;

export type TurnDeps = {
	store: DoStore;
	profile: PartnerProfile;
	partnerUserId: string;
	now: () => Date;
	createRouter: () => ModelRouter;
	entities: EntityResolver;
	history: HistoryWriter;
	memory: MemoryRepo;
	openLoops: OpenLoopRepo;
	interestOpinion: InterestOpinionRepo;
	/** 発声の身体の状態。声が無効な環境では unavailable。 */
	bodyState: () => Promise<BodyState>;
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

const isCalledByName = (deps: TurnDeps, msg: InboundMessage): boolean => {
	const text = msg.content.toLowerCase();
	return deps.profile.aliases.some((a) => text.includes(a.toLowerCase()));
};

// 自分以外へのメンション、または自分の発言ではない発言へのリプライ。
const isAddressedToOther = (deps: TurnDeps, msg: InboundMessage): boolean => {
	if (msg.mentionedUserIds.some((id) => id !== deps.partnerUserId)) return true;
	return (
		msg.replyToMessageId !== null &&
		deps.store.getMessage(msg.replyToMessageId)?.isPartner !== true
	);
};

const loadInterestOpinion = (deps: TurnDeps) =>
	deps.interestOpinion.current(deps.profile).catch(() => ({
		interests: resolveInterests(deps.profile, []),
		opinions: resolveOpinions(deps.profile, []),
	}));

type GateVerdict = { join: true } | { join: false; outcome: TurnOutcome };

// 宛先のない発言に自分から入るかを Haiku に決めさせる。失敗は llm_health に数えず、黙る。
const judgeInterjection = async (
	deps: TurnDeps,
	msg: InboundMessage,
	interests: Awaited<ReturnType<typeof loadInterestOpinion>>["interests"],
): Promise<GateVerdict> => {
	const now = deps.now();
	const minutesSince = (d: Date) =>
		Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000));
	const last = deps.store.lastPartnerReplyAt(msg.channelId);
	const prompt = buildGatePrompt({
		profile: deps.profile,
		interests: [...interests]
			.sort((a, b) => b.score - a.score)
			.map((i) => ({
				topic: i.topic,
				label: i.label,
				score: i.score,
				summary: i.summary,
			})),
		recent: deps.store
			.recentMessages(msg.channelId, msg.messageId)
			.map((m) => ({
				speaker: m.authorName,
				text: m.content,
				minutesAgo: minutesSince(new Date(m.occurredAt)),
				isPartner: m.isPartner,
			})),
		minutesSincePartnerSpoke: last ? minutesSince(last) : null,
		message: { speaker: msg.author.displayName, text: msg.content },
	});

	const started = Date.now();
	let decision: GateDecision;
	let routed: RoutedResult<GateDecision>;
	try {
		const result = await deps.createRouter().generate({
			system: prompt.system,
			messages: prompt.messages,
			output: gateOutput,
			model: HAIKU,
			maxTokens: GATE_MAX_OUTPUT_TOKENS,
		});
		if (!result.ok) {
			return {
				join: false,
				outcome: ignoreOutcome(msg, "gate_failed", {
					errorType: result.error.type,
					latencyMs: Date.now() - started,
				}),
			};
		}
		routed = result.value;
		decision = routed.output;
	} catch {
		return {
			join: false,
			outcome: ignoreOutcome(msg, "gate_failed", {
				errorType: "unexpected",
				latencyMs: Date.now() - started,
			}),
		};
	}
	if (decision.join) return { join: true };
	return {
		join: false,
		outcome: ignoreOutcome(msg, "gate_rejected", {
			decisionSummary: decision.reason,
			model: routed.model,
			usage: routed.usage,
			latencyMs: routed.latencyMs,
		}),
	};
};

export const runTurn = async (
	deps: TurnDeps,
	msg: InboundMessage,
): Promise<TurnOutcome> => {
	if (msg.author.id === deps.partnerUserId) return ignoreOutcome(msg, "self");
	if (msg.author.isBot) return ignoreOutcome(msg, "bot");

	const { profile, store } = deps;
	const mentioned = msg.mentionedUserIds.includes(deps.partnerUserId);
	// 枠の外から、宛先なしの発言に自分から入るターン。
	let interjection = false;
	let gateInterests:
		| Awaited<ReturnType<typeof loadInterestOpinion>>
		| undefined;
	if (!mentioned && !isContinuation(deps, msg) && !isCalledByName(deps, msg)) {
		if (isAddressedToOther(deps, msg)) {
			return ignoreOutcome(msg, "addressed_to_other");
		}
		const lastInterjection = store.lastInterjectionAt(msg.channelId);
		if (
			lastInterjection &&
			deps.now().getTime() - lastInterjection.getTime() <=
				INTERJECTION_COOLDOWN_MS
		) {
			return ignoreOutcome(msg, "interjection_cooldown");
		}
		gateInterests = await loadInterestOpinion(deps);
		const verdict = await judgeInterjection(deps, msg, gateInterests.interests);
		if (!verdict.join) return verdict.outcome;
		interjection = true;
	}

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
	const openLoops = await deps.openLoops
		.topOpen(partnerId, entityId)
		.catch(() => []);

	// 取得に失敗してもプロファイルの初期値で応答する。
	const current = gateInterests ?? (await loadInterestOpinion(deps));

	// 取れなくても会話は続ける（声は使えないものとして扱う）。
	const bodyState = await deps
		.bodyState()
		.catch((): BodyState => "unavailable");

	const prompt = new PromptBuilder().build({
		profile,
		bodyState,
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
		interests: [...current.interests]
			.sort((a, b) => b.score - a.score)
			.map((i) => ({
				topic: i.topic,
				label: i.label,
				score: i.score,
				summary: i.summary,
			})),
		opinions: current.opinions.map((o) => ({
			topic: o.topic,
			label: o.label,
			stance: o.stance,
			confidence: o.confidence,
		})),
		openLoops,
		now: seededAt,
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

	if (!result.ok) {
		const failedAt = deps.now();
		// await を挟まず同期で読み直し・適用・保存する（他チャンネルのターンとの競合を避ける）。
		const current = store.getState() ?? state0;
		const health = applyLlmFailure(
			current,
			store.getLlmFailureStreak(),
			failedAt,
		);
		store.setLlmFailureStreak(health.failureStreak);
		recordHealth(deps, msg, current, health, failedAt);
		return degraded(
			msg,
			result.error,
			Date.now() - started,
			health.enteredDegraded ? "entered" : null,
		);
	}

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
				reason: "turn_delta",
				sourceEventId: msg.eventId,
				occurredAt: at,
			}),
		);
	}
	const health = applyLlmSuccess(stateUpdate.state, at);
	store.setLlmFailureStreak(health.failureStreak);
	recordHealth(deps, msg, stateUpdate.state, health, at);
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

	const utterance = output.utterance.trim();
	const replying = output.reply_policy === "reply" && utterance !== "";

	// ignore のターンは会話に加わっていないので、Open Loop は追加も解決もしない。
	// 次のターンの prompt と audit に結果を載せるため、memory と同じく応答前に書き終える。
	let openLoopAudit: TurnAuditData["openLoops"] = null;
	if (replying) {
		try {
			const r = await deps.openLoops.process(
				{
					partnerId,
					entityId,
					channelId: msg.channelId,
					sourceMessageId: msg.messageId,
					now: at,
				},
				{
					candidates: output.open_loops.map((l) => ({
						summary: l.summary,
						importance: l.importance,
						dueAt: l.due_at,
						dueConfidence: l.due_confidence,
					})),
					resolveIds: output.resolved_open_loop_ids,
				},
			);
			openLoopAudit = {
				added: r.addedIds,
				resolved: r.resolvedIds,
				rejected: r.rejected.map((x) => x.reason),
				error: null,
			};
		} catch (e) {
			openLoopAudit = {
				added: [],
				resolved: [],
				rejected: [],
				error: e instanceof Error ? e.message : "open loop write failed",
			};
		}
	}

	// Open Loop と同じく、ignore のターンでは興味も意見も動かさない。
	let interestOpinionAudit: TurnAuditData["interestOpinion"] = null;
	if (replying) {
		try {
			const r = await deps.interestOpinion.process(
				{ profile, sourceMessageId: msg.messageId, now: at },
				{
					interests: output.interest_signals.map((s) => ({
						topic: s.topic,
						direction: s.direction,
						reason: s.reason,
					})),
					opinions: output.opinion_signals.map((s) => ({
						topic: s.topic,
						direction: s.direction,
						newStance: s.new_stance,
						reason: s.reason,
					})),
				},
			);
			interestOpinionAudit = { ...r, error: null };
		} catch (e) {
			interestOpinionAudit = {
				interests: { applied: [], rejected: [] },
				opinions: { applied: [], rejected: [] },
				error: e instanceof Error ? e.message : "interest/opinion write failed",
			};
		}
	}

	const common = {
		memory,
		openLoops: openLoopAudit,
		interestOpinion: interestOpinionAudit,
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
		degradedTransition: health.recovered ? ("recovered" as const) : null,
	};
	if (!replying) {
		return ignoreOutcome(msg, "llm", common);
	}

	deps.store.setLastPartnerReplyAt(msg.channelId, at);
	if (interjection) deps.store.setLastInterjectionAt(msg.channelId, at);
	// 実際の Discord message id は Gateway が送信するまで分からないため、仮の ID で文脈に残し、
	// 送信後の sent 通知で結び付ける。
	const partnerMessageId = `partner:${newId()}`;
	deps.store.appendRecent({
		channelId: msg.channelId,
		messageId: partnerMessageId,
		authorId: deps.partnerUserId,
		authorName: profile.display_name,
		isBot: false,
		isPartner: true,
		content: utterance,
		occurredAt: at.toISOString(),
	});
	return {
		intent: toBodyIntent(output, bodyState),
		response: {
			action: "reply",
			content: utterance,
			reply_to_message_id: msg.messageId,
			partner_message_id: partnerMessageId,
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
	degradedTransition: TurnAuditData["degradedTransition"] = null,
): TurnOutcome =>
	ignoreOutcome(msg, "error", {
		degraded: true,
		errorType: error.type,
		latencyMs,
		degradedTransition,
	});

// state の保存と D1 履歴の登録。変化がなければ何もしない。
const recordHealth = (
	deps: TurnDeps,
	msg: InboundMessage,
	before: PartnerState,
	health: LlmHealthUpdate,
	at: Date,
) => {
	if (health.state === before || !health.reason) return;
	deps.store.putState(health.state);
	deps.background(
		deps.history.recordStateTransition({
			partnerId: deps.profile.partner_id,
			before,
			after: health.state,
			delta: { mood: 0, energy: 0 },
			reason: health.reason,
			sourceEventId: msg.eventId,
			occurredAt: at,
		}),
	);
};

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
