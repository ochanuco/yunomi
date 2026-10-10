import {
	newId,
	type PartnerState,
	type RelationshipDelta,
	type StateDelta,
} from "@yunomi/core";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { relationshipEvents, stateTransitions } from "../db/schema.ts";

export type StateTransitionRecord = {
	partnerId: string;
	before: PartnerState;
	after: PartnerState;
	delta: StateDelta;
	sourceEventId: string;
	occurredAt: Date;
};

export type RelationshipEventRecord = {
	partnerId: string;
	entityId: string;
	delta: RelationshipDelta;
	summary: string;
	sourceEventId: string;
	occurredAt: Date;
};

/** 現在値は DO にあり、D1 は変化の履歴だけを持つ。書き込みは応答経路から外して呼び出し側が待つ。 */
export type HistoryWriter = {
	recordStateTransition(r: StateTransitionRecord): Promise<void>;
	recordRelationshipEvent(r: RelationshipEventRecord): Promise<void>;
};

export const createHistoryWriter = (db: DrizzleD1Database): HistoryWriter => ({
	async recordStateTransition(r) {
		await db.insert(stateTransitions).values({
			id: newId(),
			partnerId: r.partnerId,
			beforeJson: JSON.stringify(r.before),
			afterJson: JSON.stringify(r.after),
			deltaJson: JSON.stringify(r.delta),
			sourceEventId: r.sourceEventId,
			occurredAt: r.occurredAt.toISOString(),
		});
	},
	async recordRelationshipEvent(r) {
		await db.insert(relationshipEvents).values({
			id: newId(),
			partnerId: r.partnerId,
			entityId: r.entityId,
			type: "turn_delta",
			summary: r.summary,
			familiarityDelta: r.delta.familiarity,
			trustDelta: r.delta.trust,
			closenessDelta: null,
			tensionDelta: null,
			source: "llm_turn",
			// delta は bounded に適用済みの値で、LLM の確信度は持たない。
			confidence: 1,
			relatedEpisodeId: null,
			reason: "bounded_delta_applied",
			occurredAt: r.occurredAt.toISOString(),
		});
	},
});
