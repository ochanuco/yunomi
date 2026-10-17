import {
	type RelationshipChangeView,
	STATE_HISTORY_MAX_ROWS,
	type StateHistoryResponse,
	type StateTransitionView,
	type StateValues,
} from "@yunomi/admin-contract";
import type { PartnerState, Relationship } from "@yunomi/core";
import { and, desc, eq, gte } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { relationshipEvents, stateTransitions } from "../db/schema.ts";

// 適用側（packages/core）の丸めと揃える。逆算で誤差を溜めないため。
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export const toStateValues = (s: PartnerState): StateValues => ({
	mood: s.mood,
	energy: s.energy,
	presence: s.presence,
	system_stress: s.systemStress,
	degraded_mode: s.degradedMode,
});

/** D1 に書かれた JSON は PartnerState そのもの。 */
const parseState = (json: string): StateValues =>
	toStateValues(JSON.parse(json) as PartnerState);

type EventRow = {
	id: string;
	entityId: string;
	occurredAt: string;
	reason: string;
	summary: string;
	familiarityDelta: number;
	trustDelta: number;
};

/**
 * 新しい順の差分を、DO の現在値から順に引いて各イベント適用後の値を求める。
 * 差分は clamp 後の実適用値（core の applyRelationshipDelta の applied）なので、
 * 逆算が飽和でずれることはない。
 */
export const reconstructRelationships = (
	rowsNewestFirst: EventRow[],
	current: Relationship[],
	names: Map<string, string>,
): RelationshipChangeView[] => {
	const running = new Map(
		current.map((r) => [
			r.entityId,
			{ familiarity: r.familiarity, trust: r.trust },
		]),
	);
	const out: RelationshipChangeView[] = [];
	for (const r of rowsNewestFirst) {
		const at = running.get(r.entityId);
		if (!at) continue;
		out.push({
			id: r.id,
			entity_id: r.entityId,
			display_name: names.get(r.entityId) ?? null,
			occurred_at: r.occurredAt,
			reason: r.reason,
			summary: r.summary,
			familiarity_delta: r.familiarityDelta,
			trust_delta: r.trustDelta,
			familiarity: at.familiarity,
			trust: at.trust,
		});
		at.familiarity = round(at.familiarity - r.familiarityDelta);
		at.trust = round(at.trust - r.trustDelta);
	}
	return out.reverse();
};

export const readStateHistory = async (
	db: DrizzleD1Database,
	partnerId: string,
	since: Date,
	current: { state: PartnerState | null; relationships: Relationship[] },
	displayNames: Map<string, string>,
): Promise<StateHistoryResponse> => {
	const sinceIso = since.toISOString();
	// 超過を検出するため 1 件多く読む。新しい側を残すので降順で取る。
	const limit = STATE_HISTORY_MAX_ROWS + 1;
	const [transitionRows, eventRows] = await Promise.all([
		db
			.select()
			.from(stateTransitions)
			.where(
				and(
					eq(stateTransitions.partnerId, partnerId),
					gte(stateTransitions.occurredAt, sinceIso),
				),
			)
			.orderBy(desc(stateTransitions.occurredAt), desc(stateTransitions.id))
			.limit(limit),
		db
			.select()
			.from(relationshipEvents)
			.where(
				and(
					eq(relationshipEvents.partnerId, partnerId),
					gte(relationshipEvents.occurredAt, sinceIso),
				),
			)
			.orderBy(desc(relationshipEvents.occurredAt), desc(relationshipEvents.id))
			.limit(limit),
	]);
	const truncated =
		transitionRows.length > STATE_HISTORY_MAX_ROWS ||
		eventRows.length > STATE_HISTORY_MAX_ROWS;

	const transitions: StateTransitionView[] = transitionRows
		.slice(0, STATE_HISTORY_MAX_ROWS)
		.reverse()
		.map((t) => ({
			id: t.id,
			occurred_at: t.occurredAt,
			reason: t.reason,
			source_event_id: t.sourceEventId,
			before: parseState(t.beforeJson),
			after: parseState(t.afterJson),
		}));
	const relationships = reconstructRelationships(
		eventRows.slice(0, STATE_HISTORY_MAX_ROWS),
		current.relationships,
		displayNames,
	);

	const first = transitions[0];
	const stateAtStart = first
		? first.before
		: current.state && toStateValues(current.state);
	return {
		since: sinceIso,
		state_at_start: stateAtStart,
		transitions,
		relationships,
		truncated,
	};
};
