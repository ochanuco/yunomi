import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
	validationFailed,
} from "@yunomi/core";
import type { CapabilityAdapter, CapabilityResponse } from "../contract.ts";
import {
	WATCH_INTERVAL_DEFAULT_HOURS,
	watchAdd,
	watchStop,
} from "../definitions/watch.ts";
import { parseToolInput } from "../input.ts";
import { checkWatchSchedule } from "../watch-schedule.ts";

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
		/** schedule の見張りでは null。 */
		intervalMinutes: number | null;
		schedule: string | null;
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

export type WatchToAdd = {
	query: string;
	sources: string[];
	/** schedule の見張りでは null。 */
	intervalMinutes: number | null;
	/** 日本時間で読む 5 項目の cron 式。間隔の見張りでは null。 */
	schedule: string | null;
	untilAt: Date | null;
};

/** watch_add の入力を検証し、置き場所に渡す形にする。Working の席が記憶の口から足す見張りも同じ検証を通す。 */
export const parseWatchAdd = (
	raw: unknown,
	now: Date,
): Result<WatchToAdd, DomainError> => {
	const input = parseToolInput(watchAdd, raw);
	if (!input.ok) return input;
	const { interval_hours, schedule, until } = input.value;
	const untilAt = until === null ? null : new Date(until);
	if (untilAt !== null && untilAt.getTime() <= now.getTime()) {
		return err(validationFailed({ issues: ["until: 過去の日時"] }));
	}
	const base = {
		query: input.value.query,
		sources: input.value.sources,
		untilAt,
	};
	if (schedule == null) {
		return ok({
			...base,
			intervalMinutes: (interval_hours ?? WATCH_INTERVAL_DEFAULT_HOURS) * 60,
			schedule: null,
		});
	}
	if (interval_hours != null) {
		return err(
			validationFailed({
				issues: ["schedule: interval_hours と一緒には指定できない"],
			}),
		);
	}
	const checked = checkWatchSchedule(schedule, now);
	if (!checked.ok) {
		return err(validationFailed({ issues: [`schedule: ${checked.error}`] }));
	}
	return ok({ ...base, intervalMinutes: null, schedule: checked.value });
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
			const input = parseWatchAdd(request.input, ctx.now);
			if (!input.ok) return input;
			const r = await deps.store.add({
				partnerId: ctx.partnerId,
				discordUserId: ctx.speakerId,
				...input.value,
				now: ctx.now,
			});
			if (!r.ok) return outcome(r.error);
			return ok({
				data: {
					status: "added",
					id: r.value.id,
					note: "登録した間隔か時刻で調べ始める。新着が無ければ知らせない。",
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
