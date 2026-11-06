import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
} from "@yunomi/core";
import type {
	DiscordButtonPressedEnvelope,
	DiscordMessageCreatedEnvelope,
} from "@yunomi/protocol";
import * as v from "valibot";

export type WorkingClientOptions = {
	/** envelope を送る URL。席の数は同じ受付の /seats/summary から読む。 */
	url: string;
	/** 受付と共有するトークン。Authorization: Bearer で送る。 */
	token: string;
	/** 席の数はこのパートナーの分を読む。受付が partners を返さなければ全体の数にする。 */
	partnerId?: string;
	timeoutMs?: number;
	fetch?: typeof fetch;
};

/** 使用率の枠ひとつ。resetsAt は UNIX ミリ秒で、枠をまだ使い始めていなければ null。 */
export type UsageWindow = { usedPercent: number; resetsAt: number | null };

/** パートナーの席で動く CLI の、5 時間枠と週枠の使用率。 */
export type Usage = { fiveHour: UsageWindow; weekly: UsageWindow };

export type SeatSummary = {
	working: number;
	/** 受付が読めていなければ null。 */
	usage: Usage | null;
};

export type WorkingClient = {
	forward: (
		envelope: DiscordMessageCreatedEnvelope | DiscordButtonPressedEnvelope,
	) => Promise<Result<void, DomainError>>;
	/** この gateway のパートナーの、作業中の席の数と CLI の使用率。 */
	seatSummary: () => Promise<Result<SeatSummary, DomainError>>;
};

const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const windowSchema = v.object({
	usedPercent: v.number(),
	resetsAt: v.nullable(v.number()),
});
const usageSchema = v.object({ fiveHour: windowSchema, weekly: windowSchema });
const summarySchema = v.object({
	working: count,
	partners: v.optional(v.record(v.string(), count)),
	usage: v.optional(v.record(v.string(), usageSchema)),
});

/**
 * 仕事カテゴリの発言と押されたボタンを Working 受付へ渡す。
 * 再送しない。受付が落ちている間の発言は捨て、雑談側の処理を待たせない。
 */
export const createWorkingClient = (
	opts: WorkingClientOptions,
): WorkingClient => {
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 10_000;
	return {
		forward: async (envelope) => {
			try {
				const res = await doFetch(opts.url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${opts.token}`,
					},
					body: JSON.stringify(envelope),
					signal: AbortSignal.timeout(timeoutMs),
				});
				if (!res.ok) {
					return err(externalServiceUnavailable({ service: "working" }));
				}
				return ok(undefined);
			} catch {
				return err(externalServiceUnavailable({ service: "working" }));
			}
		},
		seatSummary: async () => {
			try {
				const res = await doFetch(new URL("/seats/summary", opts.url), {
					headers: { authorization: `Bearer ${opts.token}` },
					signal: AbortSignal.timeout(timeoutMs),
				});
				if (!res.ok) {
					return err(externalServiceUnavailable({ service: "working" }));
				}
				const parsed = v.safeParse(
					summarySchema,
					await res.json().catch(() => null),
				);
				if (!parsed.success) {
					return err(externalServiceUnavailable({ service: "working" }));
				}
				const { partnerId } = opts;
				const own = partnerId ? parsed.output.partners?.[partnerId] : undefined;
				const usage = partnerId ? parsed.output.usage?.[partnerId] : undefined;
				return ok({
					working: own ?? parsed.output.working,
					usage: usage ?? null,
				});
			} catch {
				return err(externalServiceUnavailable({ service: "working" }));
			}
		},
	};
};
