import { DurableObject } from "cloudflare:workers";
import { dedupeKey, type InboundMessage } from "@yunomi/protocol";
import { ChannelGate } from "./channel-gate.ts";
import {
	ignoreOutcome,
	type Pipeline,
	stubPipeline,
	type TurnOutcome,
} from "./pipeline.ts";
import { migrateDoStorage } from "./schema.ts";
import { DoStore, type StoredResult } from "./store.ts";

export type HandleResult = StoredResult;

export class PartnerDO extends DurableObject<Env> {
	readonly #store: DoStore;
	readonly #gate = new ChannelGate();
	// 同一イベントが処理中に再送されたとき、同じ結果を共有する。
	readonly #inflight = new Map<string, Promise<HandleResult>>();

	/** テストが差し替える。 */
	pipeline: Pipeline = stubPipeline;
	now: () => Date = () => new Date();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#store = new DoStore(ctx.storage.sql);
		ctx.blockConcurrencyWhile(async () => migrateDoStorage(ctx.storage.sql));
	}

	ping(): { ok: true; rows: number } {
		const [row] = this.ctx.storage.sql.exec("SELECT 1 AS one").toArray();
		return { ok: true, rows: Number(row?.one ?? 0) };
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

	async #process(inbound: InboundMessage, key: string): Promise<HandleResult> {
		// 待機中の発言も次の判定の文脈になるよう、直列化の前に積む。
		this.#store.appendInbound(inbound);
		const result = await this.#gate.run<HandleResult>(
			inbound.channelId,
			() => this.pipeline(inbound).then(toResult),
			() => toResult(ignoreOutcome(inbound, "coalesced")),
		);
		this.#store.putProcessed(key, this.now(), result);
		return result;
	}
}

const toResult = (o: TurnOutcome): HandleResult => ({
	...o.response,
	audit: o.audit,
});
