import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { workingEvents } from "./db/schema.ts";

export const workingEventKinds = [
	"started",
	"asking",
	"done",
	"failed",
] as const;
export type WorkingEventKind = (typeof workingEventKinds)[number];

export const workingDoneStatuses = ["完了", "見張り中", "引き継ぎ"] as const;
export type WorkingDoneStatus = (typeof workingDoneStatuses)[number];

/** Talking の prompt の「今の仕事」に出す数。 */
export const WORKING_EVENT_PROMPT_LIMIT = 5;
/** 終わった席を「今の仕事」に出しておく長さ。 */
export const WORKING_EVENT_FINISHED_SHOWN_MS = 24 * 60 * 60 * 1000;
/** 終わった席の行を残す長さ。過ぎたら日次 cron が消す。 */
export const WORKING_EVENT_FINISHED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type WorkingEvent = {
	threadId: string;
	title: string;
	event: WorkingEventKind;
	status: WorkingDoneStatus | null;
	summary: string | null;
	at: Date;
};

export type WorkingEventRepo = {
	/** 席の最新の出来事を置く。持っている出来事より古ければ何もしない。 */
	record(input: WorkingEvent & { partnerId: string; now: Date }): Promise<void>;
	/** 動いている席と判断待ちの席、1 日以内に終わった席を新しい順に WORKING_EVENT_PROMPT_LIMIT 件。 */
	current(partnerId: string, now: Date): Promise<WorkingEvent[]>;
};

const finished = inArray(workingEvents.event, ["done", "failed"]);

export const createWorkingEventRepo = (
	db: DrizzleD1Database,
): WorkingEventRepo => ({
	async record({
		partnerId,
		threadId,
		title,
		event,
		status,
		summary,
		at,
		now,
	}) {
		const row = {
			partnerId,
			threadId,
			title,
			event,
			status,
			summary,
			at: at.toISOString(),
			updatedAt: now.toISOString(),
		};
		// 読んでから書くと、同じ席の出来事が続けて届いたときに古い方が勝ちうる。比べるのは 1 文の中で行う。
		await db
			.insert(workingEvents)
			.values(row)
			.onConflictDoUpdate({
				target: [workingEvents.partnerId, workingEvents.threadId],
				set: {
					title: row.title,
					event: row.event,
					status: row.status,
					summary: row.summary,
					at: row.at,
					updatedAt: row.updatedAt,
				},
				setWhere: sql`excluded.at >= ${workingEvents.at}`,
			})
			.run();
	},

	async current(partnerId, now) {
		const shownSince = new Date(
			now.getTime() - WORKING_EVENT_FINISHED_SHOWN_MS,
		).toISOString();
		const rows = await db
			.select()
			.from(workingEvents)
			.where(
				and(
					eq(workingEvents.partnerId, partnerId),
					or(
						inArray(workingEvents.event, ["started", "asking"]),
						gte(workingEvents.at, shownSince),
					),
				),
			)
			.orderBy(desc(workingEvents.at), desc(workingEvents.threadId))
			.limit(WORKING_EVENT_PROMPT_LIMIT);
		return rows.map((r) => ({
			threadId: r.threadId,
			title: r.title,
			event: r.event,
			status: r.status,
			summary: r.summary,
			at: new Date(r.at),
		}));
	},
});

/** 終わってから 7 日を過ぎた席の行を消す。動いている席と判断待ちの席は残す。 */
export const purgeFinishedWorkingEvents = async (
	db: DrizzleD1Database,
	now: Date,
): Promise<number> => {
	const before = new Date(
		now.getTime() - WORKING_EVENT_FINISHED_RETENTION_MS,
	).toISOString();
	const res = await db
		.delete(workingEvents)
		.where(and(finished, lt(workingEvents.at, before)))
		.run();
	return res.meta.changes;
};
