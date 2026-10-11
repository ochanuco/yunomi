import {
	applyInterestSignals,
	applyOpinionSignals,
	type InterestSignal,
	type InterestState,
	lifestyleDay,
	newId,
	type OpinionSignal,
	type OpinionState,
	type PartnerProfile,
	type RejectedSignal,
	resolveInterests,
	resolveOpinions,
	type StoredInterest,
	type StoredOpinion,
} from "@yunomi/core";
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
	interestChanges,
	interestStates,
	opinionChanges,
	opinionStates,
} from "./db/schema.ts";

export type InterestOpinionWriteContext = {
	profile: PartnerProfile;
	sourceMessageId: string;
	now: Date;
};

export type InterestOpinionOutcome = {
	interests: {
		applied: { topic: string; before: number; after: number }[];
		rejected: RejectedSignal[];
	};
	opinions: {
		applied: {
			topic: string;
			direction: OpinionSignal["direction"];
			beforeConfidence: number;
			afterConfidence: number;
			stanceReplaced: boolean;
		}[];
		rejected: RejectedSignal[];
	};
};

export type InterestOpinionRepo = {
	/** プロファイルの順。保存済みの行があればそれを、なければ初期値を返す。 */
	current(
		profile: PartnerProfile,
	): Promise<{ interests: InterestState[]; opinions: OpinionState[] }>;
	process(
		ctx: InterestOpinionWriteContext,
		input: { interests: InterestSignal[]; opinions: OpinionSignal[] },
	): Promise<InterestOpinionOutcome>;
};

const parseStrings = (json: string): string[] => {
	try {
		const v: unknown = JSON.parse(json);
		return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
	} catch {
		return [];
	}
};

export const createInterestOpinionRepo = (
	db: DrizzleD1Database,
): InterestOpinionRepo => {
	const storedInterests = async (
		partnerId: string,
	): Promise<StoredInterest[]> =>
		db
			.select({
				topic: interestStates.topic,
				score: interestStates.score,
				baseline: interestStates.baseline,
				learnedDelta: interestStates.learnedDelta,
				summary: interestStates.summary,
				updatedAt: interestStates.updatedAt,
			})
			.from(interestStates)
			.where(eq(interestStates.partnerId, partnerId));

	const storedOpinions = async (
		partnerId: string,
	): Promise<StoredOpinion[]> => {
		const rows = await db
			.select()
			.from(opinionStates)
			.where(eq(opinionStates.partnerId, partnerId));
		return rows.map((r) => ({
			topic: r.topic,
			stance: r.stance,
			confidence: r.confidence,
			stability: r.stability,
			reasons: parseStrings(r.reasons),
			sourceMemoryIds: parseStrings(r.sourceMemoryIds),
			updatedAt: r.updatedAt,
		}));
	};

	return {
		async current(profile) {
			const partnerId = profile.partner_id;
			const [i, o] = await Promise.all([
				storedInterests(partnerId),
				storedOpinions(partnerId),
			]);
			return {
				interests: resolveInterests(profile, i),
				opinions: resolveOpinions(profile, o),
			};
		},

		async process(ctx, input) {
			const { profile } = ctx;
			const partnerId = profile.partner_id;
			const at = ctx.now.toISOString();
			const day = lifestyleDay(
				ctx.now,
				profile.living_rhythm.lifestyle_day_boundary,
			);

			const [i, o, netRows, changedRows] = await Promise.all([
				storedInterests(partnerId),
				storedOpinions(partnerId),
				db
					.select({
						topic: interestChanges.topic,
						net: sql<number>`sum(${interestChanges.afterScore} - ${interestChanges.beforeScore})`,
					})
					.from(interestChanges)
					.where(
						and(
							eq(interestChanges.partnerId, partnerId),
							eq(interestChanges.lifestyleDay, day),
						),
					)
					.groupBy(interestChanges.topic),
				db
					.selectDistinct({ topic: opinionChanges.topic })
					.from(opinionChanges)
					.where(
						and(
							eq(opinionChanges.partnerId, partnerId),
							eq(opinionChanges.lifestyleDay, day),
						),
					),
			]);

			const interestUpdate = applyInterestSignals(
				resolveInterests(profile, i),
				input.interests,
				Object.fromEntries(netRows.map((r) => [r.topic, Number(r.net)])),
				ctx.now,
			);
			const opinionUpdate = applyOpinionSignals(
				resolveOpinions(profile, o),
				input.opinions,
				new Set(changedRows.map((r) => r.topic)),
				ctx.now,
			);

			const writes = [
				...interestUpdate.changes.flatMap((c) => [
					db
						.insert(interestStates)
						.values({
							partnerId,
							topic: c.topic,
							score: c.after.score,
							baseline: c.after.baseline,
							learnedDelta: c.after.learnedDelta,
							summary: c.after.summary,
							updatedAt: at,
							source: "learned",
						})
						.onConflictDoUpdate({
							target: [interestStates.partnerId, interestStates.topic],
							set: {
								score: c.after.score,
								learnedDelta: c.after.learnedDelta,
								updatedAt: at,
								source: "learned",
							},
						}),
					db.insert(interestChanges).values({
						id: newId(),
						partnerId,
						topic: c.topic,
						beforeScore: c.before.score,
						afterScore: c.after.score,
						reason: c.reason,
						sourceMessageId: ctx.sourceMessageId,
						lifestyleDay: day,
						createdAt: at,
					}),
				]),
				...opinionUpdate.changes.flatMap((c) => [
					db
						.insert(opinionStates)
						.values({
							partnerId,
							topic: c.topic,
							stance: c.after.stance,
							confidence: c.after.confidence,
							stability: c.after.stability,
							reasons: JSON.stringify(c.after.reasons),
							sourceMemoryIds: JSON.stringify(c.after.sourceMemoryIds),
							updatedAt: at,
						})
						.onConflictDoUpdate({
							target: [opinionStates.partnerId, opinionStates.topic],
							set: {
								stance: c.after.stance,
								confidence: c.after.confidence,
								reasons: JSON.stringify(c.after.reasons),
								updatedAt: at,
							},
						}),
					db.insert(opinionChanges).values({
						id: newId(),
						partnerId,
						topic: c.topic,
						direction: c.direction,
						beforeStance: c.before.stance,
						afterStance: c.after.stance,
						beforeConfidence: c.before.confidence,
						afterConfidence: c.after.confidence,
						reason: c.reason,
						sourceMessageId: ctx.sourceMessageId,
						lifestyleDay: day,
						createdAt: at,
					}),
				]),
			];
			const [first, ...rest] = writes;
			if (first) await db.batch([first, ...rest]);

			return {
				interests: {
					applied: interestUpdate.changes.map((c) => ({
						topic: c.topic,
						before: c.before.score,
						after: c.after.score,
					})),
					rejected: interestUpdate.rejected,
				},
				opinions: {
					applied: opinionUpdate.changes.map((c) => ({
						topic: c.topic,
						direction: c.direction,
						beforeConfidence: c.before.confidence,
						afterConfidence: c.after.confidence,
						stanceReplaced: c.stanceReplaced,
					})),
					rejected: opinionUpdate.rejected,
				},
			};
		},
	};
};
