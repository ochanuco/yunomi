import type { GoalStore, GoalStoreError } from "@yunomi/capabilities";
import { err, newId, ok, type Result } from "@yunomi/core";
import { and, asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { externalIdentities, workNotes } from "./db/schema.ts";
import type { IndexChangeListener } from "./memory-index/types.ts";

export const workNoteKinds = ["decided", "done", "goal"] as const;

export type WorkNoteKind = (typeof workNoteKinds)[number];

/** 出来事として Talking の記憶に混ぜる種類。goal は別の区画に出す。 */
export const workEpisodeKinds = ["decided", "done"] as const;

export type WorkEpisodeKind = (typeof workEpisodeKinds)[number];

/** Talking の prompt に混ぜる件数。新しいものから採る。 */
export const WORK_NOTE_PROMPT_LIMIT = 10;
export const WORK_NOTE_SUMMARY_MAX_LENGTH = 200;
/**
 * 1 人が同時に持てる目標の数。全件を Talking と見回りの材料に毎回載せるので、増えすぎないようにする。
 */
export const OPEN_GOAL_LIMIT = 10;

/** Talking の記憶の行で predicate の位置に置く語。 */
export const WORK_NOTE_PREDICATE = {
	decided: "仕事で決めたこと",
	done: "仕事で終えたこと",
} as const satisfies Record<WorkEpisodeKind, string>;

export const goalClosings = ["achieved", "dropped"] as const;

export type GoalClosing = (typeof goalClosings)[number];

export type WorkNote = {
	id: string;
	kind: WorkNoteKind;
	summary: string;
	createdAt: Date;
};

export type Goal = { id: string; summary: string; createdAt: Date };

export type GoalAddError = { type: "duplicate" } | { type: "limit" };

export type WorkNoteRepo = {
	/** goal は openGoal で足す。 */
	add(input: {
		partnerId: string;
		entityId: string;
		kind: WorkEpisodeKind;
		summary: string;
		now: Date;
	}): Promise<WorkNote>;
	/** 同じ要約の目標がもう open なら duplicate、OPEN_GOAL_LIMIT に達していれば limit。 */
	openGoal(input: {
		partnerId: string;
		entityId: string;
		summary: string;
		now: Date;
	}): Promise<Result<Goal, GoalAddError>>;
	/** open な目標を閉じる。対象が無い（別の人の目標、閉じ済み）なら null。 */
	closeGoal(input: {
		partnerId: string;
		entityId: string;
		id: string;
		status: GoalClosing;
		now: Date;
	}): Promise<Goal | null>;
	/** open な目標を古い順に。 */
	openGoals(partnerId: string, entityId: string): Promise<Goal[]>;
};

/**
 * entity は Talking で話したことのある相手だけを引く。ここでは作らないので、
 * Working の読み書きで entities / external_identities に行が増えることはない。
 */
export const findDiscordEntity = async (
	db: DrizzleD1Database,
	discordUserId: string,
): Promise<string | null> => {
	const [row] = await db
		.select({ entityId: externalIdentities.entityId })
		.from(externalIdentities)
		.where(
			and(
				eq(externalIdentities.provider, "discord"),
				eq(externalIdentities.externalId, discordUserId),
			),
		);
	return row?.entityId ?? null;
};

const toGoal = (r: { id: string; summary: string; createdAt: string }) => ({
	id: r.id,
	summary: r.summary,
	createdAt: new Date(r.createdAt),
});

export const createWorkNoteRepo = (
	db: DrizzleD1Database,
	onIndexChange: IndexChangeListener = () => {},
): WorkNoteRepo => {
	const noteAdded = (sourceId: string) =>
		onIndexChange([{ kind: "work_note", sourceId }]);
	const openGoalRows = (partnerId: string, entityId: string) =>
		and(
			eq(workNotes.partnerId, partnerId),
			eq(workNotes.entityId, entityId),
			eq(workNotes.kind, "goal"),
			eq(workNotes.status, "open"),
		);
	const openGoals = async (partnerId: string, entityId: string) =>
		(
			await db
				.select({
					id: workNotes.id,
					summary: workNotes.summary,
					createdAt: workNotes.createdAt,
				})
				.from(workNotes)
				.where(openGoalRows(partnerId, entityId))
				.orderBy(asc(workNotes.createdAt), asc(workNotes.id))
		).map(toGoal);

	return {
		async add({ partnerId, entityId, kind, summary, now }) {
			const id = newId();
			await db.insert(workNotes).values({
				id,
				partnerId,
				entityId,
				kind,
				summary,
				createdAt: now.toISOString(),
			});
			noteAdded(id);
			return { id, kind, summary, createdAt: now };
		},

		async openGoal({ partnerId, entityId, summary, now }) {
			const current = await openGoals(partnerId, entityId);
			if (current.some((g) => g.summary === summary)) {
				return err({ type: "duplicate" });
			}
			if (current.length >= OPEN_GOAL_LIMIT) {
				return err({ type: "limit" });
			}
			const id = newId();
			await db.insert(workNotes).values({
				id,
				partnerId,
				entityId,
				kind: "goal",
				summary,
				createdAt: now.toISOString(),
				status: "open",
			});
			noteAdded(id);
			return ok({ id, summary, createdAt: now });
		},

		async closeGoal({ partnerId, entityId, id, status, now }) {
			const [row] = await db
				.update(workNotes)
				.set({ status, closedAt: now.toISOString() })
				.where(and(openGoalRows(partnerId, entityId), eq(workNotes.id, id)))
				.returning({
					id: workNotes.id,
					summary: workNotes.summary,
					createdAt: workNotes.createdAt,
				});
			return row ? toGoal(row) : null;
		},

		openGoals,
	};
};

/** Talking の道具（goal_add / goal_close）が書く先。話し手の Discord user id から entity を引く。 */
export const createGoalStore = (
	db: DrizzleD1Database,
	onIndexChange?: IndexChangeListener,
): GoalStore => {
	const repo = createWorkNoteRepo(db, onIndexChange);
	const withEntity = async <T>(
		discordUserId: string,
		f: (entityId: string) => Promise<Result<T, GoalStoreError>>,
	): Promise<Result<T, GoalStoreError>> => {
		try {
			const entityId = await findDiscordEntity(db, discordUserId);
			// ターンの最初に entity を作ってあるので、ここで無いのは D1 の不整合
			if (entityId === null) return err({ type: "unavailable" });
			return await f(entityId);
		} catch {
			return err({ type: "unavailable" });
		}
	};
	return {
		add: ({ partnerId, discordUserId, summary, now }) =>
			withEntity(discordUserId, (entityId) =>
				repo.openGoal({ partnerId, entityId, summary, now }),
			),
		close: ({ partnerId, discordUserId, id, status, now }) =>
			withEntity(discordUserId, async (entityId) => {
				const goal = await repo.closeGoal({
					partnerId,
					entityId,
					id,
					status,
					now,
				});
				return goal === null ? err({ type: "not_found" }) : ok(goal);
			}),
	};
};
