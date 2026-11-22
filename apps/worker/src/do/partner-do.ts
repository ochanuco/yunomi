import { DurableObject } from "cloudflare:workers";
import { relationshipTier } from "@yunomi/conversation";
import {
	type BodyIntent,
	type BodyState,
	type CommunicationPort,
	err,
	externalServiceUnavailable,
	type PartnerProfile,
	type PartnerState,
	type Relationship,
	resolveAivoiceRealization,
	toAivoiceValues,
} from "@yunomi/core";
import { ClaudeProvider, type LLMProvider, ModelRouter } from "@yunomi/llm";
import {
	type AvatarDirective,
	type DiscordSent,
	type DiscordVoiceConnection,
	dedupeKey,
	type GatewayResponse,
	type HeardUtterance,
	heardDedupeKey,
	heardToInbound,
	type InboundMessage,
	replyMessagesOf,
	type SpeakDirective,
	VOICE_DIRECTIVE,
	type VoiceDirective,
	type VoiceResponse,
	type VoiceSocketMessage,
	type VoiceStateUpdate,
	withSpeakQueue,
} from "@yunomi/protocol";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
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
import {
	exportTurnTrace,
	type LangfuseConfig,
	langfuseConfig,
	TurnTrace,
} from "../langfuse.ts";
import { createMemoryRepo, type MemoryRepo } from "../memory.ts";
import {
	createRecaller,
	type IndexChangeListener,
	indexTurnConversation,
	type Recaller,
	syncVectors,
	type VectorDeps,
	vectorDepsFromEnv,
	vectorSyncListener,
} from "../memory-index/index.ts";
import { createOpenLoopRepo, type OpenLoopRepo } from "../open-loops.ts";
import { otherPartners, partnerDiscord } from "../partner-discord.ts";
import { defaultPartnerProfile, partnerProfile } from "../partners.ts";
import { defaultVoiceOrgans, type VoiceOrgans } from "../voice-organs.ts";
import {
	createWatchRepo,
	createWatchStore,
	type WatchRepo,
} from "../watches.ts";
import {
	createGoalStore,
	createWorkNoteRepo,
	type WorkNoteRepo,
} from "../work-notes.ts";
import {
	createWorkingEventRepo,
	type WorkingEventRepo,
} from "../working-events.ts";
import { ChannelGate } from "./channel-gate.ts";
import { createEntityResolver, type EntityResolver } from "./entities.ts";
import { createHistoryWriter, type HistoryWriter } from "./history.ts";
import { createPendingStore } from "./pending-store.ts";
import { ignoreOutcome, type Pipeline, type TurnOutcome } from "./pipeline.ts";
import { migrateDoStorage } from "./schema.ts";
import {
	messageNonce,
	NONCE_MAX_LENGTH,
	sendMessages,
} from "./send-messages.ts";
import {
	DoStore,
	type RecentMessage,
	type RelationshipRow,
	type StoredResult,
	toRecentMessage,
} from "./store.ts";
import type { TurnCapabilities } from "./tool-loop.ts";
import { runTurn } from "./turn.ts";
import { VoiceBody } from "./voice.ts";

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

/** yunomi-voice の WebSocket に付ける Hibernation API のタグ。 */
export const VOICE_SOCKET_TAG = "voice";

// 返事の送信を Worker が担うのは、フラグとそのパートナーの bot の token が揃っているときだけ。揃わなければ Gateway に reply を返す。
const defaultCommunication = (
	env: Env,
	partnerId: string,
): CommunicationPort | null => {
	const token = partnerDiscord(env, partnerId).botToken;
	return env.DISCORD_SEND_FROM_WORKER === "1" && token
		? createDiscordRest({ token })
		: null;
};

export class PartnerDO extends DurableObject<Env> {
	/**
	 * DO は idFromName(partner_id) で引かれるので、名前からパートナーが決まる。
	 * 名簿にない名前（疎通確認の health、テストの DO）は既定のパートナーとして振る舞う。
	 */
	readonly profile: PartnerProfile;
	readonly #store: DoStore;
	readonly #gate = new ChannelGate();
	readonly #pending = new Set<Promise<void>>();
	readonly #entities: EntityResolver;
	readonly #history: HistoryWriter;
	readonly #memory: MemoryRepo;
	readonly #recaller: Recaller;
	readonly #openLoops: OpenLoopRepo;
	readonly #workNotes: WorkNoteRepo;
	readonly #watches: WatchRepo;
	readonly #workingEvents: WorkingEventRepo;
	readonly #interestOpinion: InterestOpinionRepo;
	readonly #audit: AuditWriter;
	readonly #conversationLog: ConversationLogWriter;
	readonly #db: DrizzleD1Database;
	// 同一イベントが処理中に再送されたとき、同じ結果を共有する。
	readonly #inflight = new Map<string, Promise<HandleResult>>();

	// 以下 9 つはテストが runInDurableObject で差し替える seam。
	now: () => Date = () => new Date();
	/** 返事のメッセージの間を待つ。 */
	sleep: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms));
	/** 既定は ANTHROPIC_API_KEY の ClaudeProvider。テストは FakeLLMProvider を包んだ router を返す。 */
	createRouter: (env: Env) => ModelRouter = defaultRouter;
	/** 返事を Discord へ送る口。null のときは Gateway が送る。 */
	createCommunication: (env: Env) => CommunicationPort | null = (env) =>
		defaultCommunication(env, this.profile.partner_id);
	/** 発声の器官。null（声が無効、設定や secret が欠けている）のときは声にしない。 */
	createVoiceOrgans: (env: Env) => VoiceOrgans | null = defaultVoiceOrgans;
	/** 持ち主の Discord user id。持ち主との会話だけを索引に入れる。prod だけが secret で持つ。 */
	ownerDiscordUserId: string | undefined;
	/** 記憶の索引の埋め込みと Vectorize。null（local、テスト）なら Vectorize へ反映しない。 */
	memoryVectors: VectorDeps | null;
	/** 道具の部品。undefined（prod で secret が揃っていない、dev を含む）ならターンは道具なしで返事を作る。 */
	capabilities: TurnCapabilities | undefined;
	/** Langfuse の送り先。null（設定が欠けている、local、テスト）なら trace を送らない。 */
	langfuse: LangfuseConfig | null;
	pipeline: Pipeline = (msg, onEngaged, observer) =>
		runTurn(
			{
				store: this.#store,
				profile: this.profile,
				partnerUserId: partnerDiscord(this.env, this.profile.partner_id).userId,
				otherPartners: otherPartners(this.env, this.profile.partner_id),
				now: () => this.now(),
				createRouter: () => {
					const router = this.createRouter(this.env);
					return observer ? router.withObserver(observer) : router;
				},
				bodyState: async (): Promise<BodyState> =>
					(await this.#voice()?.bodyState()) ?? "unavailable",
				entities: this.#entities,
				history: this.#history,
				memory: this.#memory,
				openLoops: this.#openLoops,
				goals: this.#workNotes,
				watches: this.#watches,
				workingEvents: this.#workingEvents,
				interestOpinion: this.#interestOpinion,
				background: (task) => this.#background(task),
				onEngaged,
				capabilities: this.capabilities,
				recall: this.#recaller,
				...(this.ownerDiscordUserId
					? { ownerUserId: this.ownerDiscordUserId }
					: {}),
			},
			msg,
		);

	/** 声の指示を送る yunomi-voice の WebSocket。テストが送信に失敗する socket を差し込む seam。 */
	voiceSockets: () => WebSocket[] = () =>
		this.ctx.getWebSockets(VOICE_SOCKET_TAG);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// 生存確認に runtime が答えるので、つないだまま待つあいだ DO は起きない。
		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair("ping", "pong"),
		);
		this.profile = partnerProfile(ctx.id.name ?? "") ?? defaultPartnerProfile;
		this.#store = new DoStore(ctx.storage.sql);
		const db = drizzle(env.DB);
		this.#db = db;
		this.memoryVectors = vectorDepsFromEnv(env);
		this.ownerDiscordUserId = env.OWNER_DISCORD_USER_ID;
		this.langfuse = langfuseConfig(env);
		// テストが memoryVectors を差し替えられるよう、呼ばれた時点の値を読む。
		const onIndexChange: IndexChangeListener = (keys) =>
			vectorSyncListener(db, this.memoryVectors, (t) => this.#background(t))(
				keys,
			);
		this.#history = createHistoryWriter(db);
		this.#memory = createMemoryRepo(db, onIndexChange);
		this.#recaller = createRecaller(db, () => this.memoryVectors);
		this.#openLoops = createOpenLoopRepo(db);
		this.#workNotes = createWorkNoteRepo(db, onIndexChange);
		this.#watches = createWatchRepo(db);
		this.#workingEvents = createWorkingEventRepo(db);
		this.#interestOpinion = createInterestOpinionRepo(db);
		this.#audit = createAuditWriter(db);
		this.#conversationLog = createConversationLogWriter(db);
		this.#entities = createEntityResolver(db, this.#store, () => this.now());
		this.capabilities =
			defaultCapabilities(
				{
					...env,
					DISCORD_BOT_TOKEN:
						partnerDiscord(env, this.profile.partner_id).botToken ?? undefined,
				},
				{
					pending: createPendingStore(ctx.storage.sql),
					policy: this.profile.capability_defaults,
					now: () => this.now(),
					goals: createGoalStore(db, onIndexChange),
					watches: createWatchStore(db),
				},
			) ?? undefined;
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
		return this.#store.listRelationships(this.profile.partner_id);
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
		return this.#once(key, () =>
			this.#process(inbound, key, undefined, (r) =>
				this.#pushVoice(inbound, r),
			),
		);
	}

	/** Worker が認証と Upgrade を確かめたあとに回してくる、yunomi-voice の WebSocket。 */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return Response.json({ error: "upgrade_required" }, { status: 426 });
		}
		// つなぎ直しで古い接続が残ると同じ声を二度流すので、新しい 1 本だけを残す。
		for (const old of this.ctx.getWebSockets(VOICE_SOCKET_TAG)) {
			try {
				old.close(1000, "replaced");
			} catch (e) {
				console.warn("voice socket close failed", e);
			}
		}
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, [VOICE_SOCKET_TAG]);
		return new Response(null, { status: 101, webSocket: client });
	}

	// yunomi-voice から送るものはまだ無い。生存確認の ping は auto response が答えるのでここに来ない。
	webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): void {
		console.warn("unexpected voice socket message", {
			length: typeof message === "string" ? message.length : message.byteLength,
		});
	}

	webSocketClose(ws: WebSocket, code: number, reason: string): void {
		// 1005 / 1006 のように送り返せない code もあるので、閉じられなくても構わない。
		try {
			ws.close(code, reason);
		} catch {}
	}

	webSocketError(_ws: WebSocket, error: unknown): void {
		console.error("voice socket error", error);
	}

	// テキストの発言のターンの声の指示は、yunomi-voice がつながっていればそこへ送り、relay への応答から外す。
	// 1 本も送れなければ、今までどおり応答に載せる。
	#pushVoice(inbound: InboundMessage, result: HandleResult): HandleResult {
		if ((result.action !== "ack" && result.action !== "reply") || !result.voice)
			return result;
		const message: VoiceSocketMessage = {
			type: VOICE_DIRECTIVE,
			partner_id: inbound.partnerId,
			guild_id: inbound.guildId,
			channel_id: inbound.channelId,
			voice: result.voice,
		};
		const data = JSON.stringify(message);
		let pushed = false;
		for (const ws of this.voiceSockets()) {
			if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
			try {
				ws.send(data);
				pushed = true;
			} catch (e) {
				console.error("voice socket send failed", e);
			}
		}
		if (!pushed) return result;
		const { voice: _voice, ...rest } = result;
		return rest;
	}

	/** VC で聞いた発話。聞き取った文字をチャットに書いてから、発言としてターンに乗せる。 */
	handleVoiceUtterance(heard: HeardUtterance): Promise<HandleResult> {
		const key = heardDedupeKey(heard);
		// 書き込みも返事の送信と同じ順番待ちに並べ、複数メッセージの返事の途中に割り込ませない。
		// まとめて飛ばされた発話も、聞き取った文字だけは残す。
		const post = () => this.#postHeard(heard);
		return this.#once(key, () =>
			this.#process(heardToInbound(heard), key, post),
		);
	}

	#once(key: string, run: () => Promise<HandleResult>): Promise<HandleResult> {
		const done = this.#store.getProcessed(key);
		if (done) return Promise.resolve(done);
		const running = this.#inflight.get(key);
		if (running) return running;

		const p = run().finally(() => this.#inflight.delete(key));
		this.#inflight.set(key, p);
		return p;
	}

	// 誰が何を言ったと聞き取ったかを、返事より先に同じチャットへ残す。
	// 書けなくても返事は止めない。送信を Gateway に任せている環境では書かない。
	async #postHeard(heard: HeardUtterance): Promise<void> {
		const port = this.createCommunication(this.env);
		if (!port) return;
		try {
			const sent = await port.sendText({
				channelId: heard.channelId,
				text: heardLine(heard),
				nonce: heardNonce(heard.eventId),
			});
			if (!sent.ok) {
				console.error(
					"discord heard post failed",
					sent.error.type,
					sent.error.message,
				);
			}
		} catch (e) {
			console.error("discord heard post threw", e);
		}
	}

	// trace は返事を送り終えてから応答経路の外で送る。送れなくてもターンの結果は変えない。
	async #runTurn(inbound: InboundMessage): Promise<HandleResult> {
		const config = this.langfuse;
		if (!config) return this.#reply(inbound);
		const trace = new TurnTrace({
			partnerId: inbound.partnerId,
			channelId: inbound.channelId,
			eventId: inbound.eventId,
			messageId: inbound.messageId,
			authorId: inbound.author.id,
			input: {
				speaker: inbound.author.displayName,
				modality: inbound.modality,
				text: inbound.content,
			},
			startedAt: Date.now(),
		});
		const result = await this.#reply(inbound, trace);
		this.#background(exportTurnTrace(config, trace, Date.now()));
		return result;
	}

	async #reply(
		inbound: InboundMessage,
		trace?: TurnTrace,
	): Promise<HandleResult> {
		const port = this.createCommunication(this.env);
		let stopTyping: (() => void) | null = null;
		const onEngaged = () => {
			if (port && !stopTyping) {
				stopTyping = this.#startTyping(port, inbound.channelId);
			}
		};
		let outcome: TurnOutcome;
		try {
			outcome = await this.pipeline(inbound, onEngaged, trace?.observe);
		} finally {
			(stopTyping as (() => void) | null)?.();
		}
		trace?.setOutput({
			decision: outcome.audit.decision,
			reason: outcome.audit.reason,
			messages: (outcome.partnerMessages ?? []).map((m) => m.content),
		});
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
		const messages = [...context, toRecentMessage(inbound), ...replies];
		this.#background(
			this.#conversationLog
				.record(
					{
						partnerId: inbound.partnerId,
						turnEventId: inbound.eventId,
						now: this.now(),
					},
					messages,
				)
				.then(() => this.#indexConversation(inbound, messages)),
		);
	}

	// 持ち主との会話だけを索引に入れる。持ち主が分からない環境（dev）では入れない。
	async #indexConversation(
		inbound: InboundMessage,
		messages: readonly LoggedMessage[],
	): Promise<void> {
		const ownerId = this.ownerDiscordUserId;
		if (!ownerId || inbound.author.id !== ownerId) return;
		const keys = await indexTurnConversation(this.#db, {
			partnerId: inbound.partnerId,
			channelId: inbound.channelId,
			ownerId,
			anchorMessageId: inbound.messageId,
			messageIds: messages.map((m) => m.messageId),
		});
		if (!keys.ok) {
			console.error("conversation index failed", keys.error);
			return;
		}
		if (!this.memoryVectors) return;
		const synced = await syncVectors(this.#db, this.memoryVectors, keys.value);
		if (!synced.ok) console.error("memory index sync failed", synced.error);
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
		const voice = this.profile.voice;
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
			report.listening ?? false,
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
			? this.#store.getRelationship(this.profile.partner_id, entityId)
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
		// 聞いた発話は Discord に無い発言なので、返信形式の宛先にできない。
		const replyTo =
			inbound.modality === "text" &&
			this.#store.hasMessagesAfter(inbound.channelId, target)
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

	async #process(
		inbound: InboundMessage,
		key: string,
		before: () => Promise<void> = async () => {},
		// 再送で同じ指示をもう一度流さないよう、保存より前に応答を整える。
		deliver: (result: HandleResult) => HandleResult = (r) => r,
	): Promise<HandleResult> {
		// 待機中の発言も次の判定の文脈になるよう、直列化の前に積む。
		this.#store.appendInbound(inbound);
		const result = deliver(
			await this.#gate.run<HandleResult>(
				inbound.channelId,
				async () => {
					await before();
					return this.#runTurn(inbound);
				},
				async () => {
					await before();
					return toResult(ignoreOutcome(inbound, "coalesced"));
				},
			),
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

const HEARD_MAX_LENGTH = 2000;

// Discord の上限は文字数なので、サロゲートペアを割らないようコードポイントで切る。
const heardLine = (heard: HeardUtterance): string =>
	Array.from(`${heard.author.displayName}: ${heard.text}`)
		.slice(0, HEARD_MAX_LENGTH)
		.join("");

// 返事の nonce は末尾が「:番号」なので、event_id の末尾だけでも重ならない。
const heardNonce = (eventId: string): string =>
	eventId.slice(-NONCE_MAX_LENGTH);

// 表情は声と同じ感情の判定から決め、画像のための LLM 呼び出しを増やさない。
// 毎回貼るとうるさいので、モデルが気持ちの大きく動いた返事として選んだときだけ貼る。
const avatarOf = (outcome: TurnOutcome): AvatarDirective | undefined =>
	outcome.intent?.showFace
		? { emotion: outcome.intent.performance.emotion }
		: undefined;

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

// 表情を貼るかは送信の結果まで決まらないので、最終的な応答から監査に写す。
const toResult = (o: TurnOutcome): HandleResult => ({
	...o.response,
	audit: o.audit.face
		? {
				...o.audit,
				face: {
					...o.audit.face,
					avatar: "avatar" in o.response && o.response.avatar !== undefined,
				},
			}
		: o.audit,
});
