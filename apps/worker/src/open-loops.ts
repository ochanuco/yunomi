import {
	newId,
	OPEN_LOOP_MAX_OPEN_PER_ENTITY,
	OPEN_LOOP_PROMPT_LIMIT,
	type OpenLoopCandidate,
	selectOpenLoopsToAdd,
} from "@yunomi/core";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { openLoops } from "./db/schema.ts";

export type OpenLoopWriteContext = {
	partnerId: string;
	/** 話し相手。解決は、この entity の open な行にしか効かない。 */
	entityId: string;
	channelId: string;
	sourceMessageId: string;
	now: Date;
};

export type OpenLoopOutcome = {
	addedIds: string[];
	resolvedIds: string[];
	rejected: { summary: string; reason: "invalid" | "duplicate" | "limit" }[];
};

export type PromptOpenLoop = {
	id: string;
	summary: string;
	dueAt: Date | null;
};

export type OpenLoopRepo = {
	process(
		ctx: OpenLoopWriteContext,
		input: { candidates: OpenLoopCandidate[]; resolveIds: string[] },
	): Promise<OpenLoopOutcome>;
	topOpen(partnerId: string, entityId: string): Promise<PromptOpenLoop[]>;
};

export const createOpenLoopRepo = (db: DrizzleD1Database): OpenLoopRepo => {
	const openRows = (partnerId: string, entityId: string) =>
		and(
			eq(openLoops.partnerId, partnerId),
			eq(openLoops.entityId, entityId),
			eq(openLoops.status, "open"),
		);

	return {
		async process(ctx, input) {
			const at = ctx.now.toISOString();
			// 解決を先に行い、同じターンで片づいた枠を追加の上限判定に使えるようにする。
			const resolveIds = [...new Set(input.resolveIds)].slice(
				0,
				OPEN_LOOP_MAX_OPEN_PER_ENTITY,
			);
			const resolved =
				resolveIds.length === 0
					? []
					: await db
							.update(openLoops)
							.set({ status: "resolved", resolvedAt: at, updatedAt: at })
							.where(
								and(
									openRows(ctx.partnerId, ctx.entityId),
									inArray(openLoops.id, resolveIds),
								),
							)
							.returning({ id: openLoops.id });

			let selection: ReturnType<typeof selectOpenLoopsToAdd> = {
				accepted: [],
				rejected: [],
			};
			if (input.candidates.length > 0) {
				const existing = await db
					.select({ summary: openLoops.summary })
					.from(openLoops)
					.where(openRows(ctx.partnerId, ctx.entityId));
				selection = selectOpenLoopsToAdd(
					input.candidates,
					existing.map((r) => r.summary),
				);
			}

			const rows = selection.accepted.map((c) => ({
				id: newId(),
				partnerId: ctx.partnerId,
				entityId: ctx.entityId,
				channelId: ctx.channelId,
				summary: c.summary,
				importance: c.importance,
				dueAt: c.dueAt,
				dueConfidence: c.dueConfidence,
				status: "open" as const,
				sourceMessageId: ctx.sourceMessageId,
				createdAt: at,
				updatedAt: at,
			}));
			if (rows.length > 0) await db.insert(openLoops).values(rows);

			return {
				addedIds: rows.map((r) => r.id),
				resolvedIds: resolved.map((r) => r.id),
				rejected: selection.rejected,
			};
		},

		async topOpen(partnerId, entityId) {
			const rows = await db
				.select({
					id: openLoops.id,
					summary: openLoops.summary,
					dueAt: openLoops.dueAt,
				})
				.from(openLoops)
				.where(openRows(partnerId, entityId))
				.orderBy(desc(openLoops.importance), desc(openLoops.createdAt))
				.limit(OPEN_LOOP_PROMPT_LIMIT);
			return rows.map((r) => ({
				...r,
				dueAt: r.dueAt === null ? null : new Date(r.dueAt),
			}));
		},
	};
};
