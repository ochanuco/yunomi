import type { memorySearchDocs } from "../db/schema.ts";

export type IndexKind = (typeof memorySearchDocs.$inferSelect)["kind"];

/** 索引の 1 文書を指す。sourceId は facts・work_notes・conversation_chunks の行 id。 */
export type IndexKey = { kind: IndexKind; sourceId: string };

/** 書き込みの経路が、索引を更新すべき行を知らせる。呼び出し側は応答を待たせずに処理する。 */
export type IndexChangeListener = (keys: IndexKey[]) => void;

export type MemoryIndexError =
	| { type: "embedding_failed"; message: string }
	| { type: "vectorize_failed"; message: string }
	| { type: "storage_failed"; message: string };

export const errorMessage = (e: unknown): string =>
	e instanceof Error ? e.message : String(e);

/** D1 は 1 文あたりの束縛変数が 100 個まで。 */
export const D1_PARAM_CHUNK = 90;

export const chunked = <T>(items: readonly T[], size: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
};
