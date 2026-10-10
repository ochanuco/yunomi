import type { KpiDay } from "@yunomi/admin-contract";
import { lifestyleDay } from "@yunomi/core";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { auditDailyKpis, auditEvents } from "./db/schema.ts";

/**
 * 毎回再集計する直近の確定済み生活日数。cron の失敗や遅延で取りこぼした日を拾う。
 * audit の保持期間（30 日）より十分短く、再集計中に元の行が消え始めることはない。
 */
export const KPI_RECOMPUTE_DAYS = 7;
export const KPI_DEFAULT_DAYS = 30;
export const KPI_MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 生活日 `YYYY-MM-DD` の開始時刻（UTC）。 */
const dayStart = (day: string, boundary: string): Date =>
	new Date(Date.parse(`${day}T${boundary}:00+09:00`));

const shiftDay = (day: string, days: number): string =>
	new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS)
		.toISOString()
		.slice(0, 10);

/** nearest-rank 法。昇順に並んだ値を渡す。 */
const percentile = (sorted: number[], p: number): number | null => {
	if (sorted.length === 0) return null;
	const rank = Math.max(1, Math.ceil(p * sorted.length));
	return sorted[rank - 1] ?? null;
};

type Row = {
	partnerId: string;
	decision: "reply" | "ignore";
	errorType: string | null;
	degraded: boolean;
	fallbackUsed: boolean;
	latencyMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	createdAt: string;
};

export const aggregateRows = (
	rows: Row[],
	boundary: string,
	now: Date,
): (typeof auditDailyKpis.$inferInsert)[] => {
	const groups = new Map<string, Row[]>();
	for (const r of rows) {
		const day = lifestyleDay(new Date(r.createdAt), boundary);
		const key = `${r.partnerId}\u0000${day}`;
		const g = groups.get(key);
		if (g) g.push(r);
		else groups.set(key, [r]);
	}
	return [...groups.entries()].map(([key, g]) => {
		const [partnerId = "", day = ""] = key.split("\u0000");
		const latencies = g
			.filter((r) => r.decision === "reply")
			.map((r) => r.latencyMs)
			.sort((a, b) => a - b);
		const sum = (f: (r: Row) => number) => g.reduce((s, r) => s + f(r), 0);
		return {
			partnerId,
			day,
			turns: g.length,
			replies: g.filter((r) => r.decision === "reply").length,
			ignores: g.filter((r) => r.decision === "ignore").length,
			errors: g.filter((r) => r.errorType !== null).length,
			degraded: g.filter((r) => r.degraded).length,
			fallbackUsed: g.filter((r) => r.fallbackUsed).length,
			latencyP50Ms: percentile(latencies, 0.5),
			latencyP95Ms: percentile(latencies, 0.95),
			inputTokens: sum((r) => r.inputTokens),
			outputTokens: sum((r) => r.outputTokens),
			cacheReadTokens: sum((r) => r.cacheReadTokens),
			cacheWriteTokens: sum((r) => r.cacheWriteTokens),
			updatedAt: now.toISOString(),
		};
	});
};

/**
 * 当日（進行中の生活日）を除く直近 KPI_RECOMPUTE_DAYS 日分を audit_events から再集計して upsert する。
 * 同じ入力なら同じ結果になるので、何度走らせてもよい。audit の削除より前に呼ぶこと。
 */
export const aggregateDailyKpis = async (
	db: DrizzleD1Database,
	now: Date,
	boundary: string,
): Promise<number> => {
	const today = lifestyleDay(now, boundary);
	const from = dayStart(shiftDay(today, -KPI_RECOMPUTE_DAYS), boundary);
	const to = dayStart(today, boundary);
	const rows = await db
		.select({
			partnerId: auditEvents.partnerId,
			decision: auditEvents.decision,
			errorType: auditEvents.errorType,
			degraded: auditEvents.degraded,
			fallbackUsed: auditEvents.fallbackUsed,
			latencyMs: auditEvents.latencyMs,
			inputTokens: auditEvents.inputTokens,
			outputTokens: auditEvents.outputTokens,
			cacheReadTokens: auditEvents.cacheReadTokens,
			cacheWriteTokens: auditEvents.cacheWriteTokens,
			createdAt: auditEvents.createdAt,
		})
		.from(auditEvents)
		.where(
			and(
				gte(auditEvents.createdAt, from.toISOString()),
				sql`${auditEvents.createdAt} < ${to.toISOString()}`,
			),
		);
	const kpis = aggregateRows(rows, boundary, now);
	const stmts = kpis.map((k) =>
		db
			.insert(auditDailyKpis)
			.values(k)
			.onConflictDoUpdate({
				target: [auditDailyKpis.partnerId, auditDailyKpis.day],
				set: k,
			}),
	);
	const [first, ...rest] = stmts;
	if (first) await db.batch([first, ...rest]);
	return kpis.length;
};

/** 現在の生活日を含めて遡る `days` 日分。新しい日が先。 */
export const readDailyKpis = async (
	db: DrizzleD1Database,
	partnerId: string,
	days: number,
	now: Date,
	boundary: string,
): Promise<KpiDay[]> => {
	const since = shiftDay(lifestyleDay(now, boundary), -(days - 1));
	const rows = await db
		.select()
		.from(auditDailyKpis)
		.where(
			and(
				eq(auditDailyKpis.partnerId, partnerId),
				gte(auditDailyKpis.day, since),
			),
		)
		.orderBy(desc(auditDailyKpis.day));
	return rows.map((r) => ({
		day: r.day,
		turns: r.turns,
		replies: r.replies,
		ignores: r.ignores,
		errors: r.errors,
		degraded: r.degraded,
		fallback_used: r.fallbackUsed,
		latency_p50_ms: r.latencyP50Ms,
		latency_p95_ms: r.latencyP95Ms,
		usage: {
			input_tokens: r.inputTokens,
			output_tokens: r.outputTokens,
			cache_read_tokens: r.cacheReadTokens,
			cache_write_tokens: r.cacheWriteTokens,
		},
	}));
};
