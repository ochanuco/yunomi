import { DurableObject } from "cloudflare:workers";
import { relationshipTier } from "@yunomi/conversation";
import {
	type BodyIntent,
	type BodyState,
	type CommunicationPort,
	err,
	externalServiceUnavailable,
	type PartnerState,
	type Relationship,
	resolveAivoiceRealization,
	toAivoiceValues,
} from "@yunomi/core";
import { ClaudeProvider, type LLMProvider, ModelRouter } from "@yunomi/llm";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import {
	type AvatarDirective,
	type DiscordSent,
	type DiscordVoiceConnection,
	dedupeKey,
	type GatewayResponse,
	type InboundMessage,
	replyMessagesOf,
	type SpeakDirective,
	type VoiceDirective,
	type VoiceResponse,
	type VoiceStateUpdate,
	withSpeakQueue,
} from "@yunomi/protocol";
import { drizzle } from "drizzle-orm/d1";
import { type AuditWriter, createAuditWriter } from "../audit-store.ts";
import { defaultCapabilities } from "../capabilities.ts";
import {
	CONTEXT_BEFORE_COUNT,
	type ConversationLogWriter,
	createConversationLogWriter,
	type LoggedMessage,
} from "../conversation-log.ts";
import { createDiscordRest } from "../discord-rest.ts";
import {
	createInterestOpinionRepo,
	type InterestOpinionRepo,
} from "../interest-opinion.ts";
import { createMemoryRepo, type MemoryRepo } from "../memory.ts";
import { createOpenLoopRepo, type OpenLoopRepo } from "../open-loops.ts";
import { defaultVoiceOrgans, type VoiceOrgans } from "../voice-organs.ts";
import { ChannelGate } from "./channel-gate.ts";
import { createEntityResolver, type EntityResolver } from "./entities.ts";
import { createHistoryWriter, type HistoryWriter } from "./history.ts";
import { createPendingStore } from "./pending-store.ts";
import { ignoreOutcome, type Pipeline, type TurnOutcome } from "./pipeline.ts";
import { migrateDoStorage } from "./schema.ts";
import { messageNonce, sendMessages } from "./send-messages.ts";
import {
	DoStore,
	type RecentMessage,
	type RelationshipRow,
	type StoredResult,
	toRecentMessage,
} from "./store.ts";
import type { TurnCapabilities } from "./tool-loop.ts";
import { runTurn } from "./turn.ts";
import { VoiceBody, wakeIfAsleep } from "./voice.ts";

const defaultRouter = (env: Env): ModelRouter => {
	const provider: LLMProvider = env.ANTHROPIC_API_KEY
		? new ClaudeProvider({ apiKey: env.ANTHROPIC_API_KEY })
		: {
				generate: async () =>
					err(externalServiceUnavailable({ service: "anthropic:no-api-key" })),
			};
	return new ModelRouter({ provider });
};

export type HandleResult = StoredResult;

// 応答が遅いときだけ入力中を出す。前段ルールですぐ決まる ignore のたびには出さない。
export const TYPING_DELAY_MS = 1500;
export const TYPING_INTERVAL_MS = 8000;

// 返事の送信を Worker が担うのは、フラグと token が揃っているときだけ。揃わなければ Gateway に reply を返す。
const defaultCommunication = (env: Env): CommunicationPort | null =>
	env.DISCORD_SEND_FROM_WORKER === "1" && env.DISCORD_BOT_TOKEN
		? createDiscordRest({ token: env.DISCORD_BOT_TOKEN })
		: null;

export class PartnerDO extends DurableObject<Env> {
	readonly #store: DoStore;
	readonly #gate = new ChannelGate();
	readonly #pending = new Set<Promise<void>>();
	readonly #entities: EntityResolver;
	readonly #history: HistoryWriter;
	readonly #memory: MemoryRepo;
	readonly #openLoops: OpenLoopRepo;
	readonly #interestOpinion: InterestOpinionRepo;
	readonly #audit: AuditWriter;
	readonly #conversationLog: ConversationLogWriter;
	// 同一イベントが処理中に再送されたとき、同じ結果を共有する。
	readonly #inflight = new Map<string, Promise<HandleResult>>();

	// 以下 6 つはテストが runInDurableObject で差し替える seam。
	now: () => Date = () => new Date();
	/** 返事のメッセージの間を待つ。 */
	sleep: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms));
	/** 既定は ANTHROPIC_API_KEY の ClaudeProvider。テストは FakeLLMProvider を包んだ router を返す。 */
	createRouter: (env: Env) => ModelRouter = defaultRouter;
	/** 返事を Discord へ送る口。null のときは Gateway が送る。 */
	createCommunication: (env: Env) => CommunicationPort | null =
		defaultCommunication;
	/** 発声の器官。null（声が無効、設定や secret が欠けている）のときは声にしない。 */
	createVoiceOrgans: (env: Env) => VoiceOrgans | null = defaultVoiceOrgans;
	/** 道具の部品。undefined（prod で secret が揃っていない、dev を含む）ならターンは道具なしで返事を作る。 */
	capabilities: TurnCapabilities | undefined;
	pipeline: Pipeline = (msg, onEngaged) =>
		runTurn(
			{
				store: this.#store,
				profile: yukarinProfile,
				partnerUserId: this.env.PARTNER_DISCORD_USER_ID,
				now: () => this.now(),
				createRouter: () => this.createRouter(this.env),
				bodyState: async (): Promise<BodyState> =>
					(await this.#voice()?.bodyState()) ?? "unavailable",
				entities: this.#entities,
				history: this.#history,
				memory: this.#memory,
				openLoops: this.#openLoops,
				interestOpinion: this.#interestOpinion,
				background: (task) => this.#background(task),
				onEngaged,
				capabilities: this.capabilities,
			},
			msg,
		);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#store = new DoStore(ctx.storage.sql);
		const db = drizzle(env.DB);
		this.#history = createHistoryWriter(db);
		this.#memory = createMemoryRepo(db);
		this.#openLoops = createOpenLoopRepo(db);
		this.#interestOpinion = createInterestOpinionRepo(db);
		this.#audit = createAuditWriter(db);
		this.#conversationLog = createConversationLogWriter(db);
		this.#entities = createEntityResolver(db, this.#store, () => this.now());
		this.capabilities =
			defaultCapabilities(env, {
				pending: createPendingStore(ctx.storage.sql),
				policy: yukarinProfile.capability_defaults,
				now: () => this.now(),
			}) ?? undefined;
		ctx.blockConcurrencyWhile(async () => migrateDoStorage(ctx.storage.sql));
	}

	ping(): { ok: true; rows: number } {
		const [row] = this.ctx.storage.sql.exec("SELECT 1 AS one").toArray();
		return { ok: true, rows: Number(row?.one ?? 0) };
	}

	/** Admin API 用。現在値は DO が持つ。 */
	adminState(): PartnerState | null {
		return this.#store.getState();
	}

	adminRelationships(): Relationship[] {
		return this.#store.listRelationships(yukarinProfile.partner_id);
	}

	/** Snapshot 用。会話本文・dedupe・channel_state は含めない。 */
	snapshotDoState(): {
		state: PartnerState | null;
		relationships: RelationshipRow[];
	} {
		return {
			state: this.#store.getState(),
			relationships: this.#store.allRelationshipRows(),
		};
	}

	/** dev の restore 用。DO の SQLite への書き込みを 1 つの transaction にする。 */
	restoreDoState(
		state: PartnerState | null,
		relationships: RelationshipRow[],
	): void {
		this.ctx.storage.transactionSync(() =>
			this.#store.replaceSnapshotState(state, relationships),
		);
	}

	#background(task: Promise<void>): void {
		const t: Promise<void> = task
			.catch((e) => console.error("background write failed", e))
			.finally(() => this.#pending.delete(t));
		this.#pending.add(t);
		this.ctx.waitUntil(t);
	}

	/** 応答経路から外した D1 書き込みの完了を待つ。テストと運用確認用。 */
	async flushBackground(): Promise<void> {
		while (this.#pending.size > 0) await Promise.all([...this.#pending]);
	}

	/** Gateway が送信できた partner 発言の Discord message id を結び付ける。 */
	bindSentMessage(sent: DiscordSent): { bound: boolean } {
		return {
			bound: this.#store.bindDiscordMessageId(
				sent.partner_message_id,
				sent.channel_id,
				sent.discord_message_id,
			),
		};
	}

	handleDiscordMessage(inbound: InboundMessage): Promise<HandleResult> {
		const key = dedupeKey(inbound);
		const done = this.#store.getProcessed(key);
		if (done) return Promise.resolve(done);
		const running = this.#inflight.get(key);
		if (running) return running;

		const p = this.#process(inbound, key).finally(() =>
			this.#inflight.delete(key),
		);
		this.#inflight.set(key, p);
		return p;
	}

	async #runTurn(inbound: InboundMessage): Promise<HandleResult> {
		const port = this.createCommunication(this.env);
		let stopTyping: (() => void) | null = null;
		const onEngaged = () => {
			if (port && !stopTyping) {
				stopTyping = this.#startTyping(port, inbound.channelId);
			}
		};
		let outcome: TurnOutcome;
		try {
			outcome = await this.pipeline(inbound, onEngaged);
		} finally {
			(stopTyping as (() => void) | null)?.();
		}
		if (outcome.response.action !== "reply") return toResult(outcome);
		if (port) {
			const sent = await this.#send(port, inbound, outcome);
			this.#logConversation(
				inbound,
				sent.map((m) => ({ ...m.row, discordMessageId: m.messageId })),
			);
			const voice = this.#voiceDirective(
				inbound,
				outcome,
				sent.map((m) => m.text),
			);
			// VC の発言への返事は VC で再生する。WAV 添付とは重ねない。
			if (outcome.intent && !voice?.speak) {
				this.#speakAloud(outcome.intent, inbound.channelId, sent);
			}
			// 一部しか送れなかった返事に表情を添えると、途切れた発言の締めに見えてしまう
			const delivered =
				sent.length > 0 &&
				sent.length === (outcome.partnerMessages ?? []).length;
			return toResult({
				...outcome,
				response: withBody(
					{ action: "ack" },
					voice,
					delivered ? avatarOf(outcome) : undefined,
				),
			});
		}
		// Gateway が送る。送れたかは sent 通知でしか分からないので、先に全件を文脈に積む。
		for (const m of outcome.partnerMessages ?? []) this.#store.appendRecent(m);
		this.#logConversation(inbound, outcome.partnerMessages ?? []);
		const voice = this.#voiceDirective(
			inbound,
			outcome,
			replyMessagesOf(outcome.response).map((m) => m.content),
		);
		return toResult({
			...outcome,
			response: withBody(outcome.response, voice, avatarOf(outcome)),
		});
	}

	// 返事をしたターンの直前の文脈・受信・返事を長期ログへ残す。応答は待たせない。
	#logConversation(
		inbound: InboundMessage,
		replies: readonly LoggedMessage[],
	): void {
		const context = this.#store
			.recentMessages(inbound.channelId, inbound.messageId)
			.slice(-CONTEXT_BEFORE_COUNT);
		this.#background(
			this.#conversationLog.record(
				{
					partnerId: inbound.partnerId,
					turnEventId: inbound.eventId,
					now: this.now(),
				},
				[...context, toRecentMessage(inbound), ...replies],
			),
		);
	}

	// 声が使えるのは、発声の器官と意思疎通の口が両方あるときだけ。
	#voice(): VoiceBody | null {
		const communication = this.createCommunication(this.env);
		const organs = this.createVoiceOrgans(this.env);
		if (!communication || !organs) return null;
		return new VoiceBody({
			storage: this.ctx.storage,
			organs,
			communication,
			hasMessagesAfter: (channelId, messageId) =>
				this.#store.hasMessagesAfter(channelId, messageId),
			now: () => this.now(),
			setAlarm: (at) => this.ctx.storage.setAlarm(at),
		});
	}

	#aivoiceValues(intent: BodyIntent) {
		const voice = yukarinProfile.voice;
		const selected = this.env.VOICE_REALIZATION;
		const resolved = voice && resolveAivoiceRealization(voice, selected);
		if (resolved?.fellBack) {
			console.warn(
				`unknown VOICE_REALIZATION "${selected}", using "${resolved.name}"`,
			);
		}
		return voice ? toAivoiceValues(intent.performance, voice, selected) : null;
	}

	// 返事の送信を待たせないよう、声は応答の外で段取りする。添付の順を保つため 1 件ずつ進める。
	#speakAloud(
		intent: BodyIntent,
		channelId: string,
		messages: readonly { text: string; messageId: string }[],
	): void {
		if (!intent.speakAloud || messages.length === 0) return;
		const values = this.#aivoiceValues(intent);
		const body = this.#voice();
		if (!values || !body) return;
		this.#background(
			(async () => {
				for (const m of messages) {
					await body.speak({
						messageId: m.messageId,
						channelId,
						text: m.text,
						values,
					});
				}
			})(),
		);
	}

	/** GPU 機が寝ていれば起こす。応答は待たせない。 */
	#wakeVoiceOrgan(): void {
		const organs = this.createVoiceOrgans(this.env);
		if (organs) this.#background(wakeIfAsleep(organs, this.now()));
	}

	// 返事のあとに Gateway へ頼む VC の操作。join は著者が VC にいて、まだ別の VC にいないときだけ。
	// 読み上げるのは送れたメッセージ（delivered）だけ。
	#voiceDirective(
		inbound: InboundMessage,
		outcome: TurnOutcome,
		delivered: readonly string[],
	): VoiceDirective | undefined {
		const connected = this.#store.getVoiceConnection()?.channelId ?? null;
		const directive: Omit<VoiceDirective, "speak" | "speak_queue"> = {};
		let queue: SpeakDirective[] = [];
		const wants = outcome.voiceChannel ?? "stay";
		if (wants === "join") {
			const target = inbound.authorVoiceChannelId;
			if (target && (connected === null || connected === target)) {
				directive.join = { guild_id: inbound.guildId, channel_id: target };
				this.#wakeVoiceOrgan();
			}
		} else if (wants === "leave" && connected !== null) {
			directive.leave = { guild_id: inbound.guildId };
		}
		if (
			delivered.length > 0 &&
			connected !== null &&
			connected === inbound.channelId &&
			wants !== "leave" &&
			outcome.intent &&
			outcome.bodyState &&
			outcome.bodyState !== "unavailable"
		) {
			const values = this.#aivoiceValues(outcome.intent);
			if (values) {
				queue = delivered.map((text) => ({
					channel_id: connected,
					text,
					values,
				}));
				if (outcome.bodyState === "asleep") this.#wakeVoiceOrgan();
			}
		}
		const voice = withSpeakQueue(directive, queue);
		return Object.keys(voice).length > 0 ? voice : undefined;
	}

	/** Gateway が VC に実際に接続・切断したあとの報告。VC の状態はこれで初めて確定する。 */
	reportVoiceConnection(report: DiscordVoiceConnection): { recorded: true } {
		this.#store.setVoiceConnection(
			report.guild_id,
			report.channel_id,
			this.now(),
		);
		return { recorded: true };
	}

	voiceConnection() {
		return this.#store.getVoiceConnection();
	}

	/** VC の出入りに、ついて行く・出る・何もしないを返す。LLM は呼ばない。 */
	async handleVoiceState(u: VoiceStateUpdate): Promise<VoiceResponse> {
		const decision = await this.#decideVoiceState(u);
		console.info("voice decision", {
			eventId: u.eventId,
			userId: u.user.id,
			from: u.fromChannelId,
			to: u.toChannelId,
			action: decision.response.action,
			reason: decision.reason,
		});
		return decision.response;
	}

	async #decideVoiceState(
		u: VoiceStateUpdate,
	): Promise<{ response: VoiceResponse; reason: string }> {
		const partnerVc =
			u.partnerChannelId ?? this.#store.getVoiceConnection()?.channelId ?? null;
		const partnerEmpty = partnerVc !== null && u.humansInPartnerChannel === 0;
		const follow = await this.#followVerdict(u, partnerVc, partnerEmpty);
		if (follow.join && u.toChannelId) {
			this.#wakeVoiceOrgan();
			return {
				response: {
					action: "voice_join",
					guild_id: u.guildId,
					channel_id: u.toChannelId,
				},
				reason: "follow",
			};
		}
		if (partnerEmpty) {
			return {
				response: { action: "voice_leave", guild_id: u.guildId },
				reason: "empty",
			};
		}
		return { response: { action: "ignore" }, reason: follow.reason };
	}

	async #followVerdict(
		u: VoiceStateUpdate,
		partnerVc: string | null,
		partnerEmpty: boolean,
	): Promise<{ join: boolean; reason: string }> {
		if (u.user.isBot) return { join: false, reason: "bot" };
		if (!u.toChannelId) return { join: false, reason: "not_in_voice" };
		if (partnerVc !== null && !partnerEmpty) {
			return { join: false, reason: "partner_busy" };
		}
		const entityId = await this.#entities
			.find("discord", u.user.id)
			.catch(() => null);
		const rel = entityId
			? this.#store.getRelationship(yukarinProfile.partner_id, entityId)
			: null;
		if (!rel) return { join: false, reason: "unknown_user" };
		const tier = relationshipTier(rel.relationship);
		if (tier !== "親しい" && tier !== "とても親しい") {
			return { join: false, reason: "not_close" };
		}
		const presence = this.#store.getState()?.presence ?? "available";
		if (
			presence === "sleeping" ||
			presence === "busy" ||
			presence === "do_not_disturb"
		) {
			return { join: false, reason: `presence_${presence}` };
		}
		const body = (await this.#voice()?.bodyState()) ?? "unavailable";
		if (body === "unavailable") return { join: false, reason: "body" };
		return { join: true, reason: "follow" };
	}

	/** 待っている声を進める。寝ていた器官が起きるのを DO の alarm で待つ。 */
	async alarm(): Promise<void> {
		try {
			await this.#voice()?.poll();
		} catch (e) {
			console.error("voice poll failed", e);
		}
	}

	#startTyping(port: CommunicationPort, channelId: string): () => void {
		const typing = () =>
			void port.sendTyping({ channelId }).then((r) => {
				if (!r.ok)
					console.warn("discord typing failed", r.error.type, r.error.message);
			});
		let interval: ReturnType<typeof setInterval> | undefined;
		const delay = setTimeout(() => {
			typing();
			interval = setInterval(typing, TYPING_INTERVAL_MS);
		}, TYPING_DELAY_MS);
		return () => {
			clearTimeout(delay);
			clearInterval(interval);
		};
	}

	// 送信に失敗しても reply は返さない。Gateway が重ねて送ると二重になりうる。
	async #send(
		port: CommunicationPort,
		inbound: InboundMessage,
		outcome: TurnOutcome,
	): Promise<{ text: string; messageId: string; row: RecentMessage }[]> {
		const rows = outcome.partnerMessages ?? [];
		const reply = outcome.response;
		const target =
			(reply.action === "reply" ? reply.reply_to_message_id : undefined) ??
			inbound.messageId;
		// 1 対 1 の流れでは普通のメッセージで送り、間に他の発言があるときだけ 1 件目を返信形式にする。
		const replyTo = this.#store.hasMessagesAfter(inbound.channelId, target)
			? target
			: undefined;
		const result = await sendMessages(
			{
				port,
				channelId: inbound.channelId,
				sleep: (ms) => this.sleep(ms),
				onSent: (i, messageId) => {
					const row = rows[i];
					if (!row) return;
					this.#store.appendRecent(row);
					this.#store.bindDiscordMessageId(
						row.messageId,
						inbound.channelId,
						messageId,
					);
				},
			},
			rows.map((row, i) => ({
				text: row.content,
				nonce: messageNonce(inbound.messageId, i),
				...(i === 0 && replyTo ? { replyToMessageId: replyTo } : {}),
			})),
		);
		if (result.end.type === "failed") {
			const { at, error } = result.end;
			console.error("discord send failed", error.type, error.message, {
				index: at,
				unsent: rows.length - at,
			});
		}
		return result.sentIds.flatMap((messageId, i) => {
			const row = rows[i];
			return row ? [{ text: row.content, messageId, row }] : [];
		});
	}

	async #process(inbound: InboundMessage, key: string): Promise<HandleResult> {
		// 待機中の発言も次の判定の文脈になるよう、直列化の前に積む。
		this.#store.appendInbound(inbound);
		const result = await this.#gate.run<HandleResult>(
			inbound.channelId,
			() => this.#runTurn(inbound),
			() => toResult(ignoreOutcome(inbound, "coalesced")),
		);
		const at = this.now();
		this.#store.putProcessed(key, at, result);
		// 自己発言は会話ではないので残さない。
		if (result.audit.reason !== "self") {
			this.#background(
				this.#audit.record(
					{
						partnerId: inbound.partnerId,
						dedupeKey: key,
						now: at,
						occurredAt: inbound.occurredAt,
					},
					result.audit,
				),
			);
		}
		return result;
	}
}

// 表情は声と同じ感情の判定から決め、画像のための LLM 呼び出しを増やさない。
const avatarOf = (outcome: TurnOutcome): AvatarDirective | undefined =>
	outcome.intent ? { emotion: outcome.intent.performance.emotion } : undefined;

const withBody = (
	response: GatewayResponse,
	voice: VoiceDirective | undefined,
	avatar: AvatarDirective | undefined,
): GatewayResponse =>
	response.action === "ack" || response.action === "reply"
		? {
				...response,
				...(voice ? { voice } : {}),
				...(avatar ? { avatar } : {}),
			}
		: response;

const toResult = (o: TurnOutcome): HandleResult => ({
	...o.response,
	audit: o.audit,
});
