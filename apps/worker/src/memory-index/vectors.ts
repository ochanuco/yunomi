import { err, ok, type Result } from "@yunomi/core";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { memorySearchDocs } from "../db/schema.ts";
import {
	chunked,
	D1_PARAM_CHUNK,
	errorMessage,
	type IndexKey,
	type IndexKind,
	type MemoryIndexError,
} from "./types.ts";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;
/** 1 回の Workers AI 呼び出しに載せる文の数。 */
export const EMBED_BATCH = 50;

export type Embedder = (
	texts: string[],
) => Promise<Result<number[][], MemoryIndexError>>;

/** Vectorize の binding のうち使う部分。テストでは差し替える。 */
export type VectorStore = {
	upsert(vectors: VectorizeVector[]): Promise<unknown>;
	deleteByIds(ids: string[]): Promise<unknown>;
	query(
		vector: number[],
		options: VectorizeQueryOptions,
	): Promise<{ matches: { id: string; score: number }[] }>;
};

export type VectorDeps = { embed: Embedder; store: VectorStore };

export const workersAiEmbedder =
	(ai: Ai): Embedder =>
	async (texts) => {
		try {
			const out = await ai.run(EMBEDDING_MODEL, { text: texts });
			if (!("data" in out) || !Array.isArray(out.data)) {
				return err({
					type: "embedding_failed",
					message: "unexpected response",
				});
			}
			if (out.data.length !== texts.length) {
				return err({
					type: "embedding_failed",
					message: `expected ${texts.length} vectors, got ${out.data.length}`,
				});
			}
			return ok(out.data);
		} catch (e) {
			return err({ type: "embedding_failed", message: errorMessage(e) });
		}
	};

/** binding が無い環境（local、テスト）では null。索引の同期と意味検索をしない。 */
export const vectorDepsFromEnv = (env: {
	AI?: Ai;
	MEMORY_INDEX?: VectorStore;
}): VectorDeps | null =>
	env.AI && env.MEMORY_INDEX
		? { embed: workersAiEmbedder(env.AI), store: env.MEMORY_INDEX }
		: null;

/** Vectorize の id は 64 byte まで。kind と行 id（UUID）を繋いでも収まる。 */
export const vectorId = (key: IndexKey): string =>
	`${key.kind}:${key.sourceId}`;

const KINDS: readonly IndexKind[] = ["fact", "work_note", "conversation"];

export const parseVectorId = (id: string): IndexKey | null => {
	const at = id.indexOf(":");
	const kind = id.slice(0, at) as IndexKind;
	if (at < 0 || !KINDS.includes(kind)) return null;
	return { kind, sourceId: id.slice(at + 1) };
};

type Doc = typeof memorySearchDocs.$inferSelect;

const toVector = (doc: Doc, values: number[]): VectorizeVector => ({
	id: vectorId(doc),
	values,
	metadata: {
		partner_id: doc.partnerId,
		kind: doc.kind,
		source_id: doc.sourceId,
		// 範囲で絞れるよう、時刻は UTC の epoch ミリ秒で持つ。
		at: Date.parse(doc.at),
	},
});

const embedAndUpsert = async (
	deps: VectorDeps,
	docs: Doc[],
): Promise<Result<number, MemoryIndexError>> => {
	for (const batch of chunked(docs, EMBED_BATCH)) {
		const embedded = await deps.embed(batch.map((d) => d.body));
		if (!embedded.ok) return embedded;
		try {
			await deps.store.upsert(
				batch.map((d, i) => toVector(d, embedded.value[i] ?? [])),
			);
		} catch (e) {
			return err({ type: "vectorize_failed", message: errorMessage(e) });
		}
	}
	return ok(docs.length);
};

/**
 * memory_search_docs を正として Vectorize を合わせる。文書があれば埋め込んで upsert し、
 * 無ければ（置き換え・削除で外れたら）Vectorize からも消す。
 */
export const syncVectors = async (
	db: DrizzleD1Database,
	deps: VectorDeps,
	keys: readonly IndexKey[],
): Promise<Result<{ upserted: number; removed: number }, MemoryIndexError>> => {
	if (keys.length === 0) return ok({ upserted: 0, removed: 0 });
	const docs: Doc[] = [];
	try {
		for (const kind of KINDS) {
			const ids = [
				...new Set(keys.filter((k) => k.kind === kind).map((k) => k.sourceId)),
			];
			for (const part of chunked(ids, D1_PARAM_CHUNK)) {
				docs.push(
					...(await db
						.select()
						.from(memorySearchDocs)
						.where(
							and(
								eq(memorySearchDocs.kind, kind),
								inArray(memorySearchDocs.sourceId, part),
							),
						)),
				);
			}
		}
	} catch (e) {
		return err({ type: "storage_failed", message: errorMessage(e) });
	}
	const present = new Set(docs.map(vectorId));
	const missing = [...new Set(keys.map(vectorId))].filter(
		(id) => !present.has(id),
	);
	const upserted = await embedAndUpsert(deps, docs);
	if (!upserted.ok) return upserted;
	if (missing.length > 0) {
		try {
			await deps.store.deleteByIds(missing);
		} catch (e) {
			return err({ type: "vectorize_failed", message: errorMessage(e) });
		}
	}
	return ok({ upserted: upserted.value, removed: missing.length });
};

/** partner の文書を id 順に limit 件ずつ埋め込み直す。既存データの一括投入に使う。 */
export const reembedDocs = async (
	db: DrizzleD1Database,
	deps: VectorDeps,
	q: { partnerId: string; afterId: number; limit: number },
): Promise<
	Result<{ processed: number; lastId: number | null }, MemoryIndexError>
> => {
	let docs: Doc[];
	try {
		docs = await db
			.select()
			.from(memorySearchDocs)
			.where(
				and(
					eq(memorySearchDocs.partnerId, q.partnerId),
					gt(memorySearchDocs.id, q.afterId),
				),
			)
			.orderBy(memorySearchDocs.id)
			.limit(q.limit);
	} catch (e) {
		return err({ type: "storage_failed", message: errorMessage(e) });
	}
	const upserted = await embedAndUpsert(deps, docs);
	if (!upserted.ok) return upserted;
	return ok({ processed: docs.length, lastId: docs.at(-1)?.id ?? null });
};

export type SearchQuery = {
	partnerId: string;
	text: string;
	topK: number;
	kinds?: readonly IndexKind[];
	/** 含む。 */
	from?: Date;
	/** 含まない。 */
	to?: Date;
};

export type VectorHit = IndexKey & { score: number };

/** 意味検索の top-k。score は cosine の類似度で、大きいほど近い。 */
export const searchVectors = async (
	deps: VectorDeps,
	q: SearchQuery,
): Promise<Result<VectorHit[], MemoryIndexError>> => {
	const embedded = await deps.embed([q.text]);
	if (!embedded.ok) return embedded;
	const at: VectorizeVectorMetadataFilter[string] = {
		...(q.from ? { $gte: q.from.getTime() } : {}),
		...(q.to ? { $lt: q.to.getTime() } : {}),
	};
	const filter: VectorizeVectorMetadataFilter = {
		partner_id: q.partnerId,
		...(q.kinds ? { kind: { $in: [...q.kinds] } } : {}),
		...(q.from || q.to ? { at } : {}),
	};
	try {
		const res = await deps.store.query(embedded.value[0] ?? [], {
			topK: q.topK,
			filter,
		});
		return ok(
			res.matches.flatMap((m) => {
				const key = parseVectorId(m.id);
				return key ? [{ ...key, score: m.score }] : [];
			}),
		);
	} catch (e) {
		return err({ type: "vectorize_failed", message: errorMessage(e) });
	}
};
