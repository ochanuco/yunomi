import { ok, type Result } from "@yunomi/core";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { detachConversationMessages } from "./chunks.ts";
import type {
	IndexChangeListener,
	IndexKey,
	MemoryIndexError,
} from "./types.ts";
import { syncVectors, type VectorDeps } from "./vectors.ts";

export {
	buildChunks,
	indexTurnConversation,
	rebuildChannelChunks,
} from "./chunks.ts";
export { searchKeywords } from "./keyword.ts";
export { parsePeriod, type RecallPeriod } from "./period.ts";
export {
	createRecaller,
	type RecalledMemory,
	type Recaller,
	type RecallRequest,
} from "./recall.ts";
export type * from "./types.ts";
export {
	searchVectors,
	syncVectors,
	type VectorDeps,
	vectorDepsFromEnv,
} from "./vectors.ts";

/**
 * 書き込みの経路に渡す listener を作る。Vectorize への反映は background に載せ、応答を待たせない。
 * FTS5 は D1 の trigger が書き込みと同じ文の中で追従するので、ここでは扱わない。
 */
export const vectorSyncListener = (
	db: DrizzleD1Database,
	vectors: VectorDeps | null,
	background: (task: Promise<void>) => void,
): IndexChangeListener => {
	if (!vectors) return () => {};
	return (keys) => {
		if (keys.length === 0) return;
		background(
			syncVectors(db, vectors, keys).then((r) => {
				if (!r.ok) console.error("memory index sync failed", r.error);
			}),
		);
	};
};

/**
 * 会話ログの行（conversation_messages.id）を索引から外す。会話ログを消す処理が、消した行の id で呼ぶ。
 * vectors が null の環境では D1 の索引（塊と FTS5）だけを直す。
 */
export const removeConversationMessagesFromIndex = async (
	db: DrizzleD1Database,
	vectors: VectorDeps | null,
	messageIds: readonly string[],
): Promise<
	Result<
		{ keys: IndexKey[]; removedChunks: number; rebuiltChunks: number },
		MemoryIndexError
	>
> => {
	const detached = await detachConversationMessages(db, messageIds);
	if (!detached.ok || !vectors) return detached;
	const synced = await syncVectors(db, vectors, detached.value.keys);
	return synced.ok ? ok(detached.value) : synced;
};
