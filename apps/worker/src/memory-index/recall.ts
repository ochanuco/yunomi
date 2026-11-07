import {
	err,
	factRetentionKind,
	formatJstForPrompt,
	isVague,
	lastTouched,
	ok,
	type Result,
	type RetentionInput,
	retention,
} from "@yunomi/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { conversationChunks, facts, workNotes } from "../db/schema.ts";
import { WORK_NOTE_PREDICATE, type WorkEpisodeKind } from "../work-notes.ts";
import { type KeywordHit, MIN_TERM_LENGTH, searchKeywords } from "./keyword.ts";
import { type RecallPeriod, recallPeriod } from "./period.ts";
import {
	chunked,
	D1_PARAM_CHUNK,
	errorMessage,
	type IndexKey,
	type IndexKind,
	type MemoryIndexError,
} from "./types.ts";
import { searchVectors, type VectorDeps, type VectorHit } from "./vectors.ts";

/** Prompt に差し込む連想の最大件数。 */
export const RECALL_LIMIT = 5;
/** 検索ごとに取る件数。固定の枠や話し相手で外れる分を見込んで多めに取る。 */
export const RECALL_SEARCH_TOP_K = 20;
export const RRF_K = 60;
/**
 * 意味検索で関連があるとみなす cosine 類似度の下限。Vectorize は無関係な文でも近い順に返すので、
 * 下限が無いと関係しない発言にも何かが浮かぶ。
 */
export const VECTOR_MIN_SCORE = 0.6;
/** 会話の塊は長いので、Prompt には頭だけを渡す。 */
export const RECALL_TEXT_MAX_LENGTH = 300;
/** うろ覚えの会話の塊は細部を落とし、頭のこの行数だけを渡す。 */
export const RECALL_VAGUE_CHUNK_LINES = 2;
/** キーワード検索に渡す語の上限。長い発言で MATCH 式が膨らまないようにする。 */
const KEYWORD_TERM_LIMIT = 12;

export type RecallCandidate = IndexKey & {
	/** RRF の値。どちらかの検索の上位にあるほど大きい。 */
	fused: number;
	vectorScore: number | null;
};

const keyOf = (k: IndexKey) => `${k.kind}:${k.sourceId}`;

/**
 * 意味検索とキーワード検索の結果を RRF でまとめる。意味検索は下限に届いたものだけを数える。
 * キーワード検索は語が一致した時点で関連があるとみなす。
 */
export const fuseHits = (
	vector: readonly VectorHit[],
	keyword: readonly KeywordHit[],
): RecallCandidate[] => {
	const out = new Map<string, RecallCandidate>();
	const add = (hit: IndexKey, rank: number, vectorScore: number | null) => {
		const key = keyOf(hit);
		const current = out.get(key) ?? {
			kind: hit.kind,
			sourceId: hit.sourceId,
			fused: 0,
			vectorScore: null,
		};
		current.fused += 1 / (RRF_K + rank);
		if (vectorScore !== null) current.vectorScore = vectorScore;
		out.set(key, current);
	};
	for (const [i, h] of vector
		.filter((h) => h.score >= VECTOR_MIN_SCORE)
		.entries()) {
		add(h, i + 1, h.score);
	}
	for (const [i, h] of keyword.entries()) add(h, i + 1, null);
	return [...out.values()];
};

/** 並べ方の基準。連想の順位はこの値だけで決める。関連の強さに保持率 R を掛ける。 */
export const recallScore = (fused: number, retention: number): number =>
	fused * retention;

/**
 * キーワード検索の語を取り出す。日本語は語の区切りが無いので、漢字・カタカナ・ASCII の英数字の連なりを語とみなし、
 * ひらがなと記号で区切る。trigram が引けない 3 文字未満の語は捨てる。
 */
export const keywordTerms = (texts: readonly string[]): string[] => {
	const terms = texts.flatMap((t) =>
		[
			...t
				.normalize("NFKC")
				.replace(/https?:\/\/\S+/g, " ")
				.replace(/<[@#][!&]?\d+>/g, " ")
				.matchAll(
					/[\p{Script=Han}々〆ヵヶ]+|[\p{Script=Katakana}ー]+|[A-Za-z0-9][A-Za-z0-9_.+-]*/gu,
				),
		].map((m) => m[0]),
	);
	return [...new Set(terms)]
		.filter((t) => [...t].length >= MIN_TERM_LENGTH)
		.slice(0, KEYWORD_TERM_LIMIT);
};

export type RecallRequest = {
	partnerId: string;
	/** 話し相手。facts と work_notes はこの人のものだけを浮かべる。 */
	entityId: string;
	/** 会話の塊は持ち主との会話なので、持ち主が話し相手のターンだけ浮かべる。 */
	includeConversation: boolean;
	/** 古い順。最後が受信した発言。 */
	cue: readonly string[];
	now: Date;
	/** 固定の枠に既にある記憶。 */
	exclude: readonly IndexKey[];
	/** この時刻以降の会話の塊は直近ログと重なるので浮かべない。 */
	conversationBefore?: Date;
};

export type RecalledMemory = {
	key: IndexKey;
	/** Prompt にそのまま出す 1 行。日時は JST に直してある。 */
	text: string;
	/** facts は observed_at、work_notes は created_at、塊は anchor の発言時刻。 */
	at: Date;
	retention: number;
	/** R が低く、日付を粗くし細部を落として渡す記憶。text は既に細部を落としてある。 */
	vague: boolean;
};

export type RecallResult = {
	memories: RecalledMemory[];
	period: RecallPeriod | null;
};

export type Recaller = {
	recall(q: RecallRequest): Promise<Result<RecallResult, MemoryIndexError>>;
	/** Prompt に差し込んだ記憶の recall_count と last_recalled_at を進める。 */
	markRecalled(
		keys: readonly IndexKey[],
		now: Date,
	): Promise<Result<void, MemoryIndexError>>;
};

const truncate = (text: string): string =>
	[...text].length > RECALL_TEXT_MAX_LENGTH
		? `${[...text].slice(0, RECALL_TEXT_MAX_LENGTH).join("")}…`
		: text;

const firstLines = (text: string): string => {
	const lines = text.split("\n");
	return lines.length > RECALL_VAGUE_CHUNK_LINES
		? `${lines.slice(0, RECALL_VAGUE_CHUNK_LINES).join("\n")}…`
		: text;
};

const idsOf = (candidates: readonly IndexKey[], kind: IndexKind) =>
	candidates.filter((c) => c.kind === kind).map((c) => c.sourceId);

// 1 回の検索で取る件数を上限にしているので、ここで読む行は D1 の束縛変数の上限に収まる。
const loadMemories = async (
	db: DrizzleD1Database,
	q: RecallRequest,
	candidates: readonly IndexKey[],
): Promise<Map<string, RecalledMemory>> => {
	const out = new Map<string, RecalledMemory>();
	const put = (
		key: IndexKey,
		text: string,
		at: string,
		r: Omit<RetentionInput, "touchedAt"> & { lastRecalledAt: string | null },
	) => {
		const value = retention(
			{ ...r, touchedAt: lastTouched(at, r.lastRecalledAt) },
			q.now,
		);
		const vague = isVague(value);
		out.set(keyOf(key), {
			key,
			text: truncate(
				vague && key.kind === "conversation" ? firstLines(text) : text,
			),
			at: new Date(at),
			retention: value,
			vague,
		});
	};

	const factIds = idsOf(candidates, "fact");
	if (factIds.length > 0) {
		const rows = await db
			.select({
				id: facts.id,
				predicate: facts.predicate,
				objectType: facts.objectType,
				objectValue: facts.objectValue,
				objectDisplay: facts.objectDisplay,
				observedAt: facts.observedAt,
				importance: facts.importance,
				decayPolicy: facts.decayPolicy,
				recallCount: facts.recallCount,
				lastRecalledAt: facts.lastRecalledAt,
				restateCount: facts.restateCount,
			})
			.from(facts)
			.where(
				and(
					inArray(facts.id, factIds),
					eq(facts.partnerId, q.partnerId),
					eq(facts.subjectEntityId, q.entityId),
					isNull(facts.validTo),
					isNull(facts.supersededBy),
				),
			);
		for (const r of rows) {
			const object =
				r.objectDisplay ??
				(r.objectType === "datetime"
					? formatJstForPrompt(new Date(r.objectValue))
					: r.objectValue);
			put(
				{ kind: "fact", sourceId: r.id },
				`${r.predicate} ${object}`,
				r.observedAt,
				{
					kind: factRetentionKind(r.decayPolicy),
					importance: r.importance,
					recallCount: r.recallCount,
					restateCount: r.restateCount,
					lastRecalledAt: r.lastRecalledAt,
				},
			);
		}
	}

	const noteIds = idsOf(candidates, "work_note");
	if (noteIds.length > 0) {
		const rows = await db
			.select({
				id: workNotes.id,
				kind: workNotes.kind,
				summary: workNotes.summary,
				status: workNotes.status,
				createdAt: workNotes.createdAt,
				recallCount: workNotes.recallCount,
				lastRecalledAt: workNotes.lastRecalledAt,
			})
			.from(workNotes)
			.where(
				and(
					inArray(workNotes.id, noteIds),
					eq(workNotes.partnerId, q.partnerId),
					eq(workNotes.entityId, q.entityId),
				),
			);
		for (const r of rows) {
			// 進行中の目標は目標の区画に全件出ている。
			if (r.kind === "goal" && r.status === "open") continue;
			const label =
				r.kind === "goal"
					? r.status === "achieved"
						? "達成した目標"
						: "やめた目標"
					: WORK_NOTE_PREDICATE[r.kind as WorkEpisodeKind];
			put(
				{ kind: "work_note", sourceId: r.id },
				`${label} ${r.summary}`,
				r.createdAt,
				{
					kind: "work_note",
					importance: null,
					recallCount: r.recallCount,
					restateCount: 0,
					lastRecalledAt: r.lastRecalledAt,
				},
			);
		}
	}

	const chunkIds = idsOf(candidates, "conversation");
	if (q.includeConversation && chunkIds.length > 0) {
		const rows = await db
			.select({
				id: conversationChunks.id,
				body: conversationChunks.body,
				occurredAt: conversationChunks.occurredAt,
				recallCount: conversationChunks.recallCount,
				lastRecalledAt: conversationChunks.lastRecalledAt,
			})
			.from(conversationChunks)
			.where(
				and(
					inArray(conversationChunks.id, chunkIds),
					eq(conversationChunks.partnerId, q.partnerId),
				),
			);
		for (const r of rows) {
			if (
				q.conversationBefore &&
				Date.parse(r.occurredAt) >= q.conversationBefore.getTime()
			) {
				continue;
			}
			put({ kind: "conversation", sourceId: r.id }, r.body, r.occurredAt, {
				kind: "conversation",
				importance: null,
				recallCount: r.recallCount,
				restateCount: 0,
				lastRecalledAt: r.lastRecalledAt,
			});
		}
	}
	return out;
};

/**
 * 返事をするターンの連想。vectors が null の環境（local、テスト）ではキーワード検索だけで引く。
 * 埋め込みや Vectorize が失敗したら error を返し、呼び出し側は連想なしで返事を作る。
 */
export const createRecaller = (
	db: DrizzleD1Database,
	vectors: () => VectorDeps | null,
): Recaller => ({
	async recall(q) {
		const cue = q.cue.map((t) => t.trim()).filter((t) => t.length > 0);
		if (cue.length === 0) return ok({ memories: [], period: null });
		const period = recallPeriod([...cue].reverse(), q.now);
		const query = {
			partnerId: q.partnerId,
			topK: RECALL_SEARCH_TOP_K,
			kinds: q.includeConversation
				? (["fact", "work_note", "conversation"] as const)
				: (["fact", "work_note"] as const),
			...(period ? { from: period.from, to: period.to } : {}),
		};
		const deps = vectors();
		const [vectorHits, keywordHits] = await Promise.all([
			deps
				? searchVectors(deps, { ...query, text: cue.join("\n") })
				: Promise.resolve(ok<VectorHit[]>([])),
			searchKeywords(db, { ...query, text: keywordTerms(cue).join(" ") }),
		]);
		if (!vectorHits.ok) return vectorHits;
		if (!keywordHits.ok) return keywordHits;

		const excluded = new Set(q.exclude.map(keyOf));
		const candidates = fuseHits(vectorHits.value, keywordHits.value).filter(
			(c) => !excluded.has(keyOf(c)),
		);
		if (candidates.length === 0) return ok({ memories: [], period });
		let loaded: Map<string, RecalledMemory>;
		try {
			loaded = await loadMemories(db, q, candidates);
		} catch (e) {
			return err({ type: "storage_failed", message: errorMessage(e) });
		}
		const memories = candidates
			.flatMap((c) => {
				const m = loaded.get(keyOf(c));
				return m ? [{ m, score: recallScore(c.fused, m.retention) }] : [];
			})
			.sort(
				(a, b) =>
					b.score - a.score || keyOf(a.m.key).localeCompare(keyOf(b.m.key)),
			)
			.slice(0, RECALL_LIMIT)
			.map(({ m }) => m);
		return ok({ memories, period });
	},

	async markRecalled(keys, now) {
		const at = now.toISOString();
		const tables = {
			fact: facts,
			work_note: workNotes,
			conversation: conversationChunks,
		} as const;
		try {
			for (const kind of Object.keys(tables) as IndexKind[]) {
				const table = tables[kind];
				for (const part of chunked(idsOf(keys, kind), D1_PARAM_CHUNK)) {
					await db
						.update(table)
						.set({
							recallCount: sql`${table.recallCount} + 1`,
							lastRecalledAt: at,
						})
						.where(inArray(table.id, part));
				}
			}
			return ok(undefined);
		} catch (e) {
			return err({ type: "storage_failed", message: errorMessage(e) });
		}
	},
});
