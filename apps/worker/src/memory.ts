import {
	CANDIDATE_TTL_MS,
	DECAY_POLICY,
	decidePromotion,
	FORGETTING,
	isVague,
	lastTouched,
	type MemoryKind,
	type MemoryObject,
	type MemorySource,
	newId,
	normalizeObject,
	normalizePredicate,
	type RetentionInput,
	retention,
} from "@yunomi/core";
import { and, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { facts, memoryCandidates, workNotes } from "./db/schema.ts";
import type { IndexChangeListener, IndexKey } from "./memory-index/types.ts";
import {
	WORK_NOTE_PREDICATE,
	WORK_NOTE_PROMPT_LIMIT,
	type WorkEpisodeKind,
	workEpisodeKinds,
} from "./work-notes.ts";

export const PROMPT_FACT_LIMIT = 30;
export const PROMPT_EPISODE_LIMIT = 30;
/**
 * 固定の枠を R の順に選ぶために読む行数の上限。R は SQL で並べられないので、最後に触れた順に多めに読んでから並べ替える。
 */
export const PROMPT_POOL_LIMIT = 200;

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
	/** 索引の文書。連想が固定の枠と同じ記憶を重ねて出さないために使う。 */
	source: IndexKey;
	kind: MemoryKind;
	predicate: string;
	/** datetime の値は Date で渡す。 */
	object: string | Date;
	observedAt: Date;
	/** R が低く、日付を粗くして渡す記憶。 */
	vague: boolean;
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
	/**
	 * 続く事実のあとに出来事を並べて返す。どちらも保持率 R の高い順に選ぶ。
	 * 出来事には Working が残した1行（work_notes の decided と done）も混ぜ、facts の出来事と合わせて R の順にする。
	 */
	topFacts(
		partnerId: string,
		entityId: string,
		now: Date,
	): Promise<PromptFact[]>;
};

export const createMemoryRepo = (
	db: DrizzleD1Database,
	onIndexChange: IndexChangeListener = () => {},
): MemoryRepo => {
	const factChanged = (sourceId: string) =>
		onIndexChange([{ kind: "fact", sourceId }]);

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
							.set({
								observedAt: at,
								decayPolicy: DECAY_POLICY[c.kind],
								restateCount: sql`${facts.restateCount} + 1`,
							})
							.where(eq(facts.id, decision.factId)),
						candidateRow("promoted", null),
					]);
					factChanged(decision.factId);
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
				factChanged(factId);
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

		async topFacts(partnerId, entityId, now) {
			const current = and(
				eq(facts.partnerId, partnerId),
				eq(facts.subjectEntityId, entityId),
				isNull(facts.validTo),
				isNull(facts.supersededBy),
			);
			const columns = {
				id: facts.id,
				predicate: facts.predicate,
				objectType: facts.objectType,
				objectValue: facts.objectValue,
				objectDisplay: facts.objectDisplay,
				observedAt: facts.observedAt,
				importance: facts.importance,
				recallCount: facts.recallCount,
				lastRecalledAt: facts.lastRecalledAt,
				restateCount: facts.restateCount,
			};
			const factTouched = sql`max(${facts.observedAt}, coalesce(${facts.lastRecalledAt}, ''))`;
			const [lasting, episodes, notes] = await db.batch([
				db
					.select(columns)
					.from(facts)
					.where(and(current, ne(facts.decayPolicy, DECAY_POLICY.episode)))
					.orderBy(desc(factTouched))
					.limit(PROMPT_POOL_LIMIT),
				db
					.select(columns)
					.from(facts)
					.where(and(current, eq(facts.decayPolicy, DECAY_POLICY.episode)))
					.orderBy(desc(factTouched))
					.limit(PROMPT_POOL_LIMIT),
				db
					.select({
						id: workNotes.id,
						kind: workNotes.kind,
						summary: workNotes.summary,
						createdAt: workNotes.createdAt,
						recallCount: workNotes.recallCount,
						lastRecalledAt: workNotes.lastRecalledAt,
					})
					.from(workNotes)
					.where(
						and(
							eq(workNotes.partnerId, partnerId),
							eq(workNotes.entityId, entityId),
							// 目標は直近の出来事に押し出されないよう、別の区画で全件を出す。
							inArray(workNotes.kind, [...workEpisodeKinds]),
						),
					)
					.orderBy(
						desc(
							sql`max(${workNotes.createdAt}, coalesce(${workNotes.lastRecalledAt}, ''))`,
						),
						desc(workNotes.id),
					)
					.limit(PROMPT_POOL_LIMIT),
			]);
			type Scored = { fact: PromptFact; r: number; importance: number };
			const scored = (
				fact: Omit<PromptFact, "vague">,
				input: Omit<RetentionInput, "touchedAt">,
				seenAt: string,
				lastRecalledAt: string | null,
			): Scored => {
				const r = retention(
					{ ...input, touchedAt: lastTouched(seenAt, lastRecalledAt) },
					now,
				);
				return {
					fact: { ...fact, vague: isVague(r) },
					r,
					importance: input.importance ?? FORGETTING.defaultImportance,
				};
			};
			const promptFact =
				(kind: MemoryKind) =>
				(r: (typeof lasting)[number]): Scored =>
					scored(
						{
							source: { kind: "fact", sourceId: r.id },
							kind,
							predicate: r.predicate,
							object:
								r.objectDisplay ??
								(r.objectType === "datetime"
									? new Date(r.objectValue)
									: r.objectValue),
							observedAt: new Date(r.observedAt),
						},
						{
							kind,
							importance: r.importance,
							recallCount: r.recallCount,
							restateCount: r.restateCount,
						},
						r.observedAt,
						r.lastRecalledAt,
					);
			const workEpisodes = notes.map((n) =>
				scored(
					{
						source: { kind: "work_note", sourceId: n.id },
						kind: "episode",
						predicate: WORK_NOTE_PREDICATE[n.kind as WorkEpisodeKind],
						object: n.summary,
						observedAt: new Date(n.createdAt),
					},
					{
						kind: "work_note",
						importance: null,
						recallCount: n.recallCount,
						restateCount: 0,
					},
					n.createdAt,
					n.lastRecalledAt,
				),
			);
			const byRetention = (items: Scored[]) =>
				items.sort(
					(a, b) =>
						// 聞いたばかりで R が並んだときは、重要なものを上にする。
						b.r - a.r ||
						b.importance - a.importance ||
						b.fact.observedAt.getTime() - a.fact.observedAt.getTime(),
				);
			const top = (items: Scored[], limit: number) =>
				byRetention(items).slice(0, limit);
			return [
				...top(lasting.map(promptFact("lasting")), PROMPT_FACT_LIMIT),
				...byRetention([
					...top(episodes.map(promptFact("episode")), PROMPT_EPISODE_LIMIT),
					...top(workEpisodes, WORK_NOTE_PROMPT_LIMIT),
				]),
			].map((s) => s.fact);
		},
	};
};

/** 昇格した内容は facts に残り、昇格の判定も候補の行を読み返さないので、期限を過ぎた行は status によらず消してよい。 */
export const purgeExpiredCandidates = async (
	db: DrizzleD1Database,
	now: Date,
): Promise<number> => {
	const res = await db
		.delete(memoryCandidates)
		.where(lt(memoryCandidates.expiresAt, now.toISOString()))
		.run();
	return res.meta.changes;
};
