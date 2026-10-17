import { newId } from "@yunomi/core";
import { lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { TurnAuditData } from "./audit.ts";
import { auditEvents } from "./db/schema.ts";

export const AUDIT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** この時刻より前に作られた audit は削除対象。 */
export const auditCutoff = (now: Date): Date =>
	new Date(now.getTime() - AUDIT_RETENTION_DAYS * DAY_MS);

export type AuditRecordContext = {
	partnerId: string;
	dedupeKey: string;
	now: Date;
	occurredAt: Date;
};

export type AuditWriter = {
	record(ctx: AuditRecordContext, audit: TurnAuditData): Promise<void>;
};

/**
 * 思考過程は保存しない。TurnAuditData が持たないものはここにも載せない。
 * 入力の概要（author など）は detail_json に、本文は inbound_content に分けて持つ。
 */
export const toAuditRow = (
	ctx: AuditRecordContext,
	audit: TurnAuditData,
): typeof auditEvents.$inferInsert => {
	const { content, ...inbound } = audit.inbound;
	return {
		id: newId(),
		partnerId: ctx.partnerId,
		eventId: audit.inbound.eventId,
		dedupeKey: ctx.dedupeKey,
		channelId: audit.inbound.channelId,
		authorEntityId: audit.relationship?.entityId ?? null,
		kind: "turn",
		decision: audit.decision,
		reason: audit.reason,
		decisionSummary: audit.decisionSummary,
		model: audit.model,
		fallbackUsed: audit.fallbackUsed,
		degraded: audit.degraded,
		errorType: audit.errorType,
		inputTokens: audit.usage?.inputTokens ?? 0,
		outputTokens: audit.usage?.outputTokens ?? 0,
		cacheReadTokens: audit.usage?.cacheReadTokens ?? 0,
		cacheWriteTokens: audit.usage?.cacheWriteTokens ?? 0,
		latencyMs: audit.latencyMs ?? 0,
		inboundContent: content,
		detailJson: JSON.stringify({
			inbound,
			state: audit.state,
			relationship: audit.relationship,
			memory: audit.memory,
			openLoops: audit.openLoops,
			interestOpinion: audit.interestOpinion,
			toolCalls: audit.toolCalls,
			degradedTransition: audit.degradedTransition,
		}),
		occurredAt: ctx.occurredAt.toISOString(),
		createdAt: ctx.now.toISOString(),
	};
};

export const createAuditWriter = (db: DrizzleD1Database): AuditWriter => ({
	async record(ctx, audit) {
		await db.insert(auditEvents).values(toAuditRow(ctx, audit));
	},
});

export const purgeExpiredAudit = async (
	db: DrizzleD1Database,
	now: Date,
): Promise<number> => {
	const res = await db
		.delete(auditEvents)
		.where(lt(auditEvents.createdAt, auditCutoff(now).toISOString()))
		.run();
	return res.meta.changes;
};
