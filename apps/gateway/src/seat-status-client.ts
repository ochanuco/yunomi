import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type PartnerId,
	type Result,
} from "@yunomi/core";
import * as v from "valibot";

/** 使用率の枠ひとつ。resetsAt は UNIX ミリ秒で、枠をまだ使い始めていなければ null。 */
export type UsageWindow = { usedPercent: number; resetsAt: number | null };

/** パートナーの席で動く CLI の、5 時間枠と週枠の使用率。 */
export type Usage = { fiveHour: UsageWindow; weekly: UsageWindow };

export type SeatSummary = {
	working: number;
	/** Working が読めていなければ null。 */
	usage: Usage | null;
};

export type SeatStatusClient = {
	/** この gateway のパートナーの、作業中の席の数と CLI の使用率。 */
	seatSummary: () => Promise<Result<SeatSummary, DomainError>>;
};

const windowSchema = v.object({
	used_percent: v.number(),
	resets_at_ms: v.nullable(v.number()),
});
const statusSchema = v.object({
	working: v.pipe(v.number(), v.integer(), v.minValue(0)),
	usage: v.nullable(
		v.object({ five_hour: windowSchema, weekly: windowSchema }),
	),
});

const toWindow = (w: v.InferOutput<typeof windowSchema>): UsageWindow => ({
	usedPercent: w.used_percent,
	resetsAt: w.resets_at_ms,
});

/** mizuya の Working の、席の状態を渡す口（/seat-status/<partner>）を読む。 */
export const createSeatStatusClient = (opts: {
	/** 口の URL。末尾の /seat-status/<partner> は付けない。 */
	url: string;
	token: string;
	partnerId: PartnerId;
	timeoutMs?: number;
	fetch?: typeof fetch;
}): SeatStatusClient => {
	const doFetch = opts.fetch ?? fetch;
	const unavailable = () =>
		err(externalServiceUnavailable({ service: "mizuya-working" }));
	return {
		seatSummary: async () => {
			try {
				const res = await doFetch(
					new URL(`/seat-status/${opts.partnerId}`, opts.url),
					{
						headers: { authorization: `Bearer ${opts.token}` },
						signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
					},
				);
				if (!res.ok) return unavailable();
				const parsed = v.safeParse(
					statusSchema,
					await res.json().catch(() => null),
				);
				if (!parsed.success) return unavailable();
				const { working, usage } = parsed.output;
				return ok({
					working,
					usage: usage
						? {
								fiveHour: toWindow(usage.five_hour),
								weekly: toWindow(usage.weekly),
							}
						: null,
				});
			} catch {
				return unavailable();
			}
		},
	};
};
