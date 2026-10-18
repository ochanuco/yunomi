import {
	CANDIDATE_TTL_MS,
	decidePromotion,
	type MemoryKind,
	type MemoryObject,
	type MemorySource,
	newId,
	normalizeObject,
	normalizePredicate,
} from "@yunomi/core";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { facts, memoryCandidates } from "./db/schema.ts";

export const PROMPT_FACT_LIMIT = 12;
export const PROMPT_EPISODE_LIMIT = 8;

/** facts.decay_policy。lasting は standard、episode は episodic に残す。 */
const DECAY_POLICY = {
	lasting: "standard",
	episode: "episodic",
} as const satisfies Record<MemoryKind, string>;

export type CandidateInput = {
	subject: string;
	predicate: string;
	object: MemoryObject;
	confidence: number;
	importance: number;
	source: MemorySource;
	kind: MemoryKind;
};

export type MemoryWriteContext = {
	partnerId: string;
	speakerEntityId: string;
	/** LLM が話者を指す語として返しうる値（表示名、Discord user id など）。 */
	speakerAliases: string[];
	sourceEventId: string;
	now: Date;
};

export type CandidateOutcome = {
	predicate: string;
	status: "pending" | "promoted" | "conflict" | "rejected";
	factId: string | null;
	conflictFactId: string | null;
};

export type PromptFact = {
	kind: MemoryKind;
	predicate: string;
	/** datetime の値は Date で渡す。 */
	object: string | Date;
	observedAt: Date;
};

const SPEAKER_WORDS = new Set(["user", "speaker"]);

const refersToSpeaker = (subject: string, aliases: string[]): boolean => {
	const s = subject.trim().toLowerCase();
	return (
		SPEAKER_WORDS.has(s) || aliases.some((a) => a.trim().toLowerCase() === s)
	);
};

export type MemoryRepo = {
	processCandidates(
		ctx: MemoryWriteContext,
		candidates: CandidateInput[],
	): Promise<CandidateOutcome[]>;
	/** 続く事実（重要度順）のあとに出来事（新しい順）を並べて返す。 */
	topFacts(partnerId: string, entityId: string): Promise<PromptFact[]>;
};

export const createMemoryRepo = (db: DrizzleD1Database): MemoryRepo => {
	const currentFact = async (
		partnerId: string,
		entityId: string,
		predicate: string,
	) => {
		const [row] = await db
			.select()
			.from(facts)
			.where(
				and(
					eq(facts.partnerId, partnerId),
					eq(facts.subjectEntityId, entityId),
					eq(facts.predicate, predicate),
					isNull(facts.validTo),
					isNull(facts.supersededBy),
				),
			);
		return row ?? null;
	};

	const processOne = async (
		ctx: MemoryWriteContext,
		c: CandidateInput,
	): Promise<CandidateOutcome> => {
		const predicate = normalizePredicate(c.predicate);
		const object = normalizeObject(c.object);
		const at = ctx.now.toISOString();
		const speaker = refersToSpeaker(c.subject, ctx.speakerAliases);
		const candidateRow = (
			status: CandidateOutcome["status"],
			conflictFactId: string | null,
		) =>
			db.insert(memoryCandidates).values({
				id: newId(),
				partnerId: ctx.partnerId,
				subjectEntityId: speaker ? ctx.speakerEntityId : null,
				subjectText: speaker ? null : c.subject,
				predicate,
				objectType: c.object.type,
				objectValue: object?.value ?? c.object.value,
				confidence: c.confidence,
				importance: c.importance,
				source: c.source,
				status,
				conflictFactId,
				expiresAt: new Date(ctx.now.getTime() + CANDIDATE_TTL_MS).toISOString(),
				createdAt: at,
				sourceEventId: ctx.sourceEventId,
			});

		if (predicate === "" || !object) {
			await candidateRow("rejected", null);
			return {
				predicate,
				status: "rejected",
				factId: null,
				conflictFactId: null,
			};
		}

		// 並行ターンが同じ (subject, predicate) を同時に insert した場合だけ unique 制約に当たるので、1 度だけ判定し直す。
		for (let attempt = 0; ; attempt++) {
			const current = speaker
				? await currentFact(ctx.partnerId, ctx.speakerEntityId, predicate)
				: null;
			const decision = decidePromotion({
				source: c.source,
				confidence: c.confidence,
				subjectIsSpeaker: speaker,
				object,
				current: current
					? {
							id: current.id,
							object: {
								type: current.objectType as MemoryObject["type"],
								value: current.objectValue,
							},
						}
					: null,
			});
			try {
				if (decision.status === "pending") {
					await candidateRow("pending", null);
					return {
						predicate,
						status: "pending",
						factId: null,
						conflictFactId: null,
					};
				}
				if (decision.status === "conflict") {
					await candidateRow("conflict", decision.conflictFactId);
					return {
						predicate,
						status: "conflict",
						factId: null,
						conflictFactId: decision.conflictFactId,
					};
				}
				if (decision.action === "refresh") {
					await db.batch([
						db
							.update(facts)
							.set({ observedAt: at, decayPolicy: DECAY_POLICY[c.kind] })
							.where(eq(facts.id, decision.factId)),
						candidateRow("promoted", null),
					]);
					return {
						predicate,
						status: "promoted",
						factId: decision.factId,
						conflictFactId: null,
					};
				}
				const factId = newId();
				await db.batch([
					db.insert(facts).values({
						id: factId,
						partnerId: ctx.partnerId,
						subjectEntityId: ctx.speakerEntityId,
						predicate,
						objectType: object.type,
						objectValue: object.value,
						objectDisplay: null,
						confidence: c.confidence,
						importance: c.importance,
						source: c.source,
						observedAt: at,
						validFrom: at,
						decayPolicy: DECAY_POLICY[c.kind],
					}),
					candidateRow("promoted", null),
				]);
				return { predicate, status: "promoted", factId, conflictFactId: null };
			} catch (e) {
				if (attempt >= 1) throw e;
			}
		}
	};

	return {
		async processCandidates(ctx, candidates) {
			const out: CandidateOutcome[] = [];
			// 同じターンの候補が互いの結果を見られるよう、直列に処理する。
			for (const c of candidates) out.push(await processOne(ctx, c));
			return out;
		},

		async topFacts(partnerId, entityId) {
			const current = and(
				eq(facts.partnerId, partnerId),
				eq(facts.subjectEntityId, entityId),
				isNull(facts.validTo),
				isNull(facts.supersededBy),
			);
			const columns = {
				predicate: facts.predicate,
				objectType: facts.objectType,
				objectValue: facts.objectValue,
				objectDisplay: facts.objectDisplay,
				observedAt: facts.observedAt,
			};
			// episodic 以外の値は standard として扱う。
			const [lasting, episodes] = await db.batch([
				db
					.select(columns)
					.from(facts)
					.where(and(current, ne(facts.decayPolicy, DECAY_POLICY.episode)))
					.orderBy(desc(facts.importance), desc(facts.observedAt))
					.limit(PROMPT_FACT_LIMIT),
				db
					.select(columns)
					.from(facts)
					.where(and(current, eq(facts.decayPolicy, DECAY_POLICY.episode)))
					.orderBy(desc(facts.observedAt))
					.limit(PROMPT_EPISODE_LIMIT),
			]);
			const promptFact =
				(kind: MemoryKind) =>
				(r: (typeof lasting)[number]): PromptFact => ({
					kind,
					predicate: r.predicate,
					object:
						r.objectDisplay ??
						(r.objectType === "datetime"
							? new Date(r.objectValue)
							: r.objectValue),
					observedAt: new Date(r.observedAt),
				});
			return [
				...lasting.map(promptFact("lasting")),
				...episodes.map(promptFact("episode")),
			];
		},
	};
};
