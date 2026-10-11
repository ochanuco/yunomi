import type {
	AuditItem,
	CandidateView,
	FactView,
	OpenLoopView,
	RelationshipView,
} from "@yunomi/admin-contract";
import type { Relationship } from "@yunomi/core";
import {
	and,
	count,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	or,
} from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
	auditEvents,
	entities,
	facts,
	memoryCandidates,
	openLoops,
} from "../db/schema.ts";
import { type Cursor, encodeCursor } from "./cursor.ts";

export type Page<T> = { items: T[]; nextCursor: string | null };

/** 1 件多く取って、次のページがあるかを判定する。 */
const paginate = <R, T>(
	rows: R[],
	limit: number,
	map: (r: R) => T,
	key: (r: R) => Cursor,
): Page<T> => {
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map(map),
		nextCursor: rows.length > limit && last ? encodeCursor(key(last)) : null,
	};
};

export const createAdminQueries = (db: DrizzleD1Database) => ({
	async counts(partnerId: string) {
		const [f] = await db
			.select({ n: count() })
			.from(facts)
			.where(
				and(
					eq(facts.partnerId, partnerId),
					isNull(facts.validTo),
					isNull(facts.supersededBy),
				),
			);
		const [c] = await db
			.select({ n: count() })
			.from(memoryCandidates)
			.where(
				and(
					eq(memoryCandidates.partnerId, partnerId),
					eq(memoryCandidates.status, "pending"),
				),
			);
		return { facts: f?.n ?? 0, pendingCandidates: c?.n ?? 0 };
	},

	async lastAuditAt(partnerId: string): Promise<string | null> {
		const [row] = await db
			.select({ at: auditEvents.createdAt })
			.from(auditEvents)
			.where(eq(auditEvents.partnerId, partnerId))
			.orderBy(desc(auditEvents.createdAt))
			.limit(1);
		return row?.at ?? null;
	},

	async relationshipViews(rels: Relationship[]): Promise<RelationshipView[]> {
		const names = new Map<string, string>();
		if (rels.length > 0) {
			const rows = await db
				.select({ id: entities.id, name: entities.displayName })
				.from(entities)
				.where(
					inArray(
						entities.id,
						rels.map((r) => r.entityId),
					),
				);
			for (const r of rows) names.set(r.id, r.name);
		}
		return rels.map((r) => ({
			entity_id: r.entityId,
			display_name: names.get(r.entityId) ?? null,
			familiarity: r.familiarity,
			trust: r.trust,
			summary: r.summary,
			version: r.version,
			updated_at: r.updatedAt,
		}));
	},

	async facts(
		partnerId: string,
		limit: number,
		cursor: Cursor | null,
		current: { now: Date } | null,
	): Promise<Page<FactView>> {
		const rows = await db
			.select()
			.from(facts)
			.where(
				and(
					eq(facts.partnerId, partnerId),
					current
						? and(
								isNull(facts.supersededBy),
								or(
									isNull(facts.validTo),
									gt(facts.validTo, current.now.toISOString()),
								),
							)
						: undefined,
					cursor
						? or(
								lt(facts.observedAt, cursor.at),
								and(eq(facts.observedAt, cursor.at), lt(facts.id, cursor.id)),
							)
						: undefined,
				),
			)
			.orderBy(desc(facts.observedAt), desc(facts.id))
			.limit(limit + 1);
		return paginate(
			rows,
			limit,
			(r) => ({
				id: r.id,
				subject_entity_id: r.subjectEntityId,
				predicate: r.predicate,
				object_type: r.objectType,
				object_value: r.objectValue,
				object_display: r.objectDisplay,
				confidence: r.confidence,
				importance: r.importance,
				source: r.source,
				observed_at: r.observedAt,
				valid_from: r.validFrom,
				valid_to: r.validTo,
				superseded_by: r.supersededBy,
			}),
			(r) => ({ at: r.observedAt, id: r.id }),
		);
	},

	async candidates(
		partnerId: string,
		limit: number,
		cursor: Cursor | null,
	): Promise<Page<CandidateView>> {
		const rows = await db
			.select()
			.from(memoryCandidates)
			.where(
				and(
					eq(memoryCandidates.partnerId, partnerId),
					cursor
						? or(
								lt(memoryCandidates.createdAt, cursor.at),
								and(
									eq(memoryCandidates.createdAt, cursor.at),
									lt(memoryCandidates.id, cursor.id),
								),
							)
						: undefined,
				),
			)
			.orderBy(desc(memoryCandidates.createdAt), desc(memoryCandidates.id))
			.limit(limit + 1);
		return paginate(
			rows,
			limit,
			(r) => ({
				id: r.id,
				subject_entity_id: r.subjectEntityId,
				subject_text: r.subjectText,
				predicate: r.predicate,
				object_type: r.objectType,
				object_value: r.objectValue,
				confidence: r.confidence,
				importance: r.importance,
				source: r.source,
				status: r.status,
				conflict_fact_id: r.conflictFactId,
				expires_at: r.expiresAt,
				created_at: r.createdAt,
				source_event_id: r.sourceEventId,
			}),
			(r) => ({ at: r.createdAt, id: r.id }),
		);
	},

	async openLoops(
		partnerId: string,
		limit: number,
		cursor: Cursor | null,
		openOnly: boolean,
	): Promise<Page<OpenLoopView>> {
		const rows = await db
			.select({ loop: openLoops, entityName: entities.displayName })
			.from(openLoops)
			.leftJoin(entities, eq(entities.id, openLoops.entityId))
			.where(
				and(
					eq(openLoops.partnerId, partnerId),
					openOnly ? eq(openLoops.status, "open") : undefined,
					cursor
						? or(
								lt(openLoops.createdAt, cursor.at),
								and(
									eq(openLoops.createdAt, cursor.at),
									lt(openLoops.id, cursor.id),
								),
							)
						: undefined,
				),
			)
			.orderBy(desc(openLoops.createdAt), desc(openLoops.id))
			.limit(limit + 1);
		return paginate(
			rows,
			limit,
			({ loop: r, entityName }) => ({
				id: r.id,
				entity_id: r.entityId,
				entity_display_name: entityName,
				channel_id: r.channelId,
				summary: r.summary,
				importance: r.importance,
				due_at: r.dueAt,
				due_confidence: r.dueConfidence,
				follow_up_interval_hours: r.followUpIntervalHours,
				status: r.status,
				source_message_id: r.sourceMessageId,
				created_at: r.createdAt,
				updated_at: r.updatedAt,
				resolved_at: r.resolvedAt,
				last_followed_up_at: r.lastFollowedUpAt,
			}),
			({ loop: r }) => ({ at: r.createdAt, id: r.id }),
		);
	},

	async audit(
		partnerId: string,
		limit: number,
		cursor: Cursor | null,
		since: string | null,
	): Promise<Page<AuditItem>> {
		const rows = await db
			.select()
			.from(auditEvents)
			.where(
				and(
					eq(auditEvents.partnerId, partnerId),
					since ? gte(auditEvents.createdAt, since) : undefined,
					cursor
						? or(
								lt(auditEvents.createdAt, cursor.at),
								and(
									eq(auditEvents.createdAt, cursor.at),
									lt(auditEvents.id, cursor.id),
								),
							)
						: undefined,
				),
			)
			.orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
			.limit(limit + 1);
		return paginate(
			rows,
			limit,
			(r) => ({
				id: r.id,
				event_id: r.eventId,
				dedupe_key: r.dedupeKey,
				channel_id: r.channelId,
				author_entity_id: r.authorEntityId,
				kind: r.kind,
				decision: r.decision,
				reason: r.reason,
				decision_summary: r.decisionSummary,
				model: r.model,
				fallback_used: r.fallbackUsed,
				degraded: r.degraded,
				error_type: r.errorType,
				usage: {
					input_tokens: r.inputTokens,
					output_tokens: r.outputTokens,
					cache_read_tokens: r.cacheReadTokens,
					cache_write_tokens: r.cacheWriteTokens,
				},
				latency_ms: r.latencyMs,
				inbound_content: r.inboundContent,
				detail: JSON.parse(r.detailJson) as Record<string, unknown>,
				occurred_at: r.occurredAt,
				created_at: r.createdAt,
			}),
			(r) => ({ at: r.createdAt, id: r.id }),
		);
	},
});
