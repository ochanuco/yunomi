import { DurableObject } from "cloudflare:workers";
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
	type DiscordSent,
	dedupeKey,
	type GatewayResponse,
	type InboundMessage,
} from "@yunomi/protocol";
import { drizzle } from "drizzle-orm/d1";
import { type AuditWriter, createAuditWriter } from "../audit-store.ts";
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
import { ignoreOutcome, type Pipeline, type TurnOutcome } from "./pipeline.ts";
import { migrateDoStorage } from "./schema.ts";
import { DoStore, type RelationshipRow, type StoredResult } from "./store.ts";
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
	// 同一イベントが処理中に再送されたとき、同じ結果を共有する。
	readonly #inflight = new Map<string, Promise<HandleResult>>();

	// 以下 4 つはテストが runInDurableObject で差し替える seam。
	now: () => Date = () => new Date();
	/** 既定は ANTHROPIC_API_KEY の ClaudeProvider。テストは FakeLLMProvider を包んだ router を返す。 */
	createRouter: (env: Env) => ModelRouter = defaultRouter;
	/** 返事を Discord へ送る口。null のときは Gateway が送る。 */
	createCommunication: (env: Env) => CommunicationPort | null =
		defaultCommunication;
	/** 発声の器官。null（声が無効、設定や secret が欠けている）のときは声にしない。 */
	createVoiceOrgans: (env: Env) => VoiceOrgans | null = defaultVoiceOrgans;
	pipeline: Pipeline = (msg) =>
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
		this.#entities = createEntityResolver(db, this.#store, () => this.now());
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
		const stopTyping = port ? this.#startTyping(port, inbound.channelId) : null;
		let outcome: TurnOutcome;
		try {
			outcome = await this.pipeline(inbound);
		} finally {
			stopTyping?.();
		}
		if (port && outcome.response.action === "reply") {
			const sent = await this.#send(port, inbound, outcome.response);
			if (sent.messageId && outcome.intent) {
				this.#speakAloud(outcome.intent, inbound.channelId, sent.messageId);
			}
			return toResult({ ...outcome, response: sent.response });
		}
		return toResult(outcome);
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
			now: () => this.now(),
			setAlarm: (at) => this.ctx.storage.setAlarm(at),
		});
	}

	// 返事の送信を待たせないよう、声は応答の外で段取りする。
	#speakAloud(intent: BodyIntent, channelId: string, messageId: string): void {
		if (!intent.speakAloud) return;
		const voice = yukarinProfile.voice;
		const selected = this.env.VOICE_REALIZATION;
		const resolved = voice && resolveAivoiceRealization(voice, selected);
		if (resolved?.fellBack) {
			console.warn(
				`unknown VOICE_REALIZATION "${selected}", using "${resolved.name}"`,
			);
		}
		const values =
			voice && toAivoiceValues(intent.performance, voice, selected);
		const body = this.#voice();
		if (!values || !body) return;
		this.#background(
			body.speak({ messageId, channelId, text: intent.text, values }),
		);
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
		reply: Extract<GatewayResponse, { action: "reply" }>,
	): Promise<{ response: GatewayResponse; messageId?: string }> {
		const sent = await port.sendText({
			channelId: inbound.channelId,
			text: reply.content,
			replyToMessageId: reply.reply_to_message_id ?? inbound.messageId,
		});
		if (!sent.ok) {
			console.error("discord send failed", sent.error.type, sent.error.message);
		} else if (reply.partner_message_id) {
			this.#store.bindDiscordMessageId(
				reply.partner_message_id,
				inbound.channelId,
				sent.value.messageId,
			);
		}
		return {
			response: { action: "ack" },
			...(sent.ok ? { messageId: sent.value.messageId } : {}),
		};
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

const toResult = (o: TurnOutcome): HandleResult => ({
	...o.response,
	audit: o.audit,
});
