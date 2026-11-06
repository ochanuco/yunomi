import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
	validationFailed,
} from "@yunomi/core";
import type { CapabilityAdapter, CapabilityResponse } from "../contract.ts";
import { watchAdd, watchStop } from "../definitions/watch.ts";
import { parseToolInput } from "../input.ts";

export type WatchStoreError =
	| { type: "duplicate" }
	| { type: "limit" }
	| { type: "not_found" }
	| { type: "unavailable" };

/** 見張りの置き場所。Worker が D1 で実装する。持ち主は Discord の user id で指す。 */
export type WatchStore = {
	add(input: {
		partnerId: string;
		discordUserId: string;
		query: string;
		sources: readonly string[];
		intervalMinutes: number;
		untilAt: Date | null;
		now: Date;
	}): Promise<Result<{ id: string }, WatchStoreError>>;
	stop(input: {
		partnerId: string;
		discordUserId: string;
		id: string;
		now: Date;
	}): Promise<Result<{ id: string; query: string }, WatchStoreError>>;
};

// gate は失敗の型名しかモデルに渡さないので、オーナーに言い分けたい結果は失敗にせず data で返す。
const NOTE: Record<Exclude<WatchStoreError["type"], "unavailable">, string> = {
	duplicate: "同じものを探す見張りがもうある。",
	limit:
		"見張りの数が上限に達している。止められる見張りがないかオーナーに聞く。",
	not_found: "その id の見張りは無いか、もう止めてある。",
};

const outcome = (
	e: WatchStoreError,
): Result<CapabilityResponse, DomainError> =>
	e.type === "unavailable"
		? err(externalServiceUnavailable({ service: "watches" }))
		: ok({
				data: { status: "not_done", reason: e.type, note: NOTE[e.type] },
				summary: `見張りを変えなかった (${e.type})`,
			});

/**
 * オーナーの見張りを登録・停止する道具。gate がオーナー以外を先に拒否するので、話し手の見張りとして書く。
 * summary に探すものは入れない（Audit に会話の中身を残さない）。
 */
export const createWatchAdapter = (deps: {
	store: WatchStore;
}): CapabilityAdapter => ({
	tools: [watchAdd, watchStop],
	async execute(request) {
		const ctx = request.context;
		if (request.tool === watchAdd.name) {
			const input = parseToolInput(watchAdd, request.input);
			if (!input.ok) return input;
			const untilAt =
				input.value.until === null ? null : new Date(input.value.until);
			if (untilAt !== null && untilAt.getTime() <= ctx.now.getTime()) {
				return err(validationFailed({ issues: ["until: 過去の日時"] }));
			}
			const r = await deps.store.add({
				partnerId: ctx.partnerId,
				discordUserId: ctx.speakerId,
				query: input.value.query,
				sources: input.value.sources,
				intervalMinutes: input.value.interval_hours * 60,
				untilAt,
				now: ctx.now,
			});
			if (!r.ok) return outcome(r.error);
			return ok({
				data: {
					status: "added",
					id: r.value.id,
					note: "次の見回りから調べ始める。新着が無ければ知らせない。",
				},
				summary: "見張りを 1 件登録した",
			});
		}
		if (request.tool === watchStop.name) {
			const input = parseToolInput(watchStop, request.input);
			if (!input.ok) return input;
			const r = await deps.store.stop({
				partnerId: ctx.partnerId,
				discordUserId: ctx.speakerId,
				id: input.value.id,
				now: ctx.now,
			});
			if (!r.ok) return outcome(r.error);
			return ok({
				data: { status: "stopped", id: r.value.id, query: r.value.query },
				summary: "見張りを 1 件止めた",
			});
		}
		return err(validationFailed({ issues: [`未知の道具: ${request.tool}`] }));
	},
});
