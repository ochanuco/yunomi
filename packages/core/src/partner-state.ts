import {
	type RelationshipUpdateRejected,
	relationshipUpdateRejected,
} from "./errors.ts";
import type { PartnerProfile } from "./partner-profile.ts";
import { lifestyleDay } from "./time.ts";

export type Presence =
	| "available"
	| "away"
	| "busy"
	| "sleeping"
	| "do_not_disturb";

export type PartnerState = {
	mood: number;
	energy: number;
	presence: Presence;
	systemStress: number;
	degradedMode: boolean;
	version: number;
	updatedAt: string;
};

export type Relationship = {
	partnerId: string;
	entityId: string;
	familiarity: number;
	trust: number;
	summary: string | null;
	version: number;
	updatedAt: string;
};

/** 生活日ごとに積み上がった familiarity / trust の増加量（正の適用分のみ）。 */
export type DailyAccumulator = {
	day: string;
	familiarity: number;
	trust: number;
};

export const TURN_CAPS = {
	mood: { up: 0.15, down: 0.15 },
	energy: { up: 0.1, down: 0.1 },
	familiarity: { up: 0.02, down: 0.05 },
	trust: { up: 0.02, down: 0.05 },
} as const;

export const DAILY_RELATIONSHIP_CAP = 0.08;

/** LLM が返す生の delta として許容する絶対値の上限。これを超えたら異常値として棄却する。 */
const SANE_DELTA = 1;

export type StateDelta = { mood: number; energy: number };
export type RelationshipDelta = { familiarity: number; trust: number };

export const initialPartnerState = (
	profile: PartnerProfile,
	now: Date,
): PartnerState => ({
	mood: profile.initial_state.mood,
	energy: profile.initial_state.energy,
	presence: "available",
	systemStress: 0,
	degradedMode: false,
	version: 1,
	updatedAt: now.toISOString(),
});

export const initialRelationship = (
	profile: PartnerProfile,
	entityId: string,
	now: Date,
): Relationship => ({
	partnerId: profile.partner_id,
	entityId,
	familiarity: profile.initial_relationship.familiarity,
	trust: profile.initial_relationship.trust,
	summary: null,
	version: 1,
	updatedAt: now.toISOString(),
});

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const clamp = (n: number, min: number, max: number) =>
	Math.min(max, Math.max(min, n));

/** 異常値（NaN / 無限大 / 絶対値が上限超）は棄却し、null と理由を返す。 */
const sane = (
	partnerId: string,
	field: string,
	d: number,
): { value: number; rejected: RelationshipUpdateRejected | null } =>
	Number.isFinite(d) && Math.abs(d) <= SANE_DELTA
		? { value: d, rejected: null }
		: {
				value: 0,
				rejected: relationshipUpdateRejected({
					partnerId,
					reason: `${field} の delta が不正: ${d}`,
				}),
			};

export type StateUpdate = {
	state: PartnerState;
	applied: StateDelta;
	rejected: RelationshipUpdateRejected[];
};

export const applyStateDelta = (
	partnerId: string,
	state: PartnerState,
	delta: StateDelta,
	now: Date,
): StateUpdate => {
	const rejected: RelationshipUpdateRejected[] = [];
	const step = (field: "mood" | "energy", min: number, max: number): number => {
		const s = sane(partnerId, field, delta[field]);
		if (s.rejected) rejected.push(s.rejected);
		const cap = TURN_CAPS[field];
		const bounded = clamp(s.value, -cap.down, cap.up);
		const next = clamp(state[field] + bounded, min, max);
		return round(next - state[field]);
	};
	const applied = { mood: step("mood", -1, 1), energy: step("energy", 0, 1) };
	if (applied.mood === 0 && applied.energy === 0) {
		return { state, applied, rejected };
	}
	return {
		state: {
			...state,
			mood: round(state.mood + applied.mood),
			energy: round(state.energy + applied.energy),
			version: state.version + 1,
			updatedAt: now.toISOString(),
		},
		applied,
		rejected,
	};
};

export type RelationshipUpdate = {
	relationship: Relationship;
	accumulator: DailyAccumulator;
	applied: RelationshipDelta;
	rejected: RelationshipUpdateRejected[];
};

export const applyRelationshipDelta = (
	relationship: Relationship,
	accumulator: DailyAccumulator | null,
	delta: RelationshipDelta,
	now: Date,
	boundary = "05:00",
): RelationshipUpdate => {
	const day = lifestyleDay(now, boundary);
	const acc: DailyAccumulator =
		accumulator && accumulator.day === day
			? accumulator
			: { day, familiarity: 0, trust: 0 };
	const rejected: RelationshipUpdateRejected[] = [];
	const next = { ...acc };

	const step = (field: "familiarity" | "trust"): number => {
		const s = sane(relationship.partnerId, field, delta[field]);
		if (s.rejected) rejected.push(s.rejected);
		const cap = TURN_CAPS[field];
		const dailyRoom = Math.max(0, DAILY_RELATIONSHIP_CAP - acc[field]);
		const bounded = clamp(s.value, -cap.down, Math.min(cap.up, dailyRoom));
		const after = clamp(relationship[field] + bounded, 0, 1);
		const applied = round(after - relationship[field]);
		if (applied > 0) next[field] = round(acc[field] + applied);
		return applied;
	};
	const applied = { familiarity: step("familiarity"), trust: step("trust") };
	if (applied.familiarity === 0 && applied.trust === 0) {
		return { relationship, accumulator: next, applied, rejected };
	}
	return {
		relationship: {
			...relationship,
			familiarity: round(relationship.familiarity + applied.familiarity),
			trust: round(relationship.trust + applied.trust),
			version: relationship.version + 1,
			updatedAt: now.toISOString(),
		},
		accumulator: next,
		applied,
		rejected,
	};
};
