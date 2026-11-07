import { err, ok, type Result } from "@yunomi/core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
	conversationChunkMessages,
	conversationChunks,
	conversationMessages,
} from "../db/schema.ts";
import {
	chunked,
	D1_PARAM_CHUNK,
	errorMessage,
	type IndexKey,
	type MemoryIndexError,
} from "./types.ts";

/** anchor の前に含める、持ち主と Partner の発言の最大件数。 */
export const CHUNK_CONTEXT_COUNT = 4;
/** anchor からこれより前の発言は、別の話題とみなして含めない。 */
export const CHUNK_CONTEXT_WINDOW_MS = 30 * 60 * 1000;
/** bge-m3 の入力上限より十分小さく抑える。 */
export const CHUNK_BODY_MAX_LENGTH = 4000;

export type ChunkMessage = {
	/** conversation_messages.id */
	id: string;
	authorId: string;
	authorName: string;
	isPartner: boolean;
	content: string;
	occurredAt: string;
};

export type Chunk = {
	/** anchor の conversation_messages.id */
	id: string;
	members: ChunkMessage[];
	body: string;
	startedAt: string;
	occurredAt: string;
	endedAt: string;
};

const isOwner = (m: ChunkMessage, ownerId: string) =>
	!m.isPartner && m.authorId === ownerId;

const time = (m: ChunkMessage) => Date.parse(m.occurredAt);

// 期間の範囲検索を文字列の比較で行うため、toISOString の形に揃える。
const iso = (m: ChunkMessage) => new Date(time(m)).toISOString();

export const chunkBody = (members: readonly ChunkMessage[]): string =>
	members
		.map((m) => `${m.authorName}: ${m.content}`)
		.join("\n")
		.slice(0, CHUNK_BODY_MAX_LENGTH);

const toChunk = (id: string, anchor: ChunkMessage, members: ChunkMessage[]) => {
	const first = members[0] ?? anchor;
	const last = members.at(-1) ?? anchor;
	return {
		id,
		members,
		body: chunkBody(members),
		startedAt: iso(first),
		occurredAt: iso(anchor),
		endedAt: iso(last),
	};
};

/**
 * 持ち主の発言のうち、すぐ後に Partner の返事が続くものを anchor にして塊を作る。
 * 塊は anchor の前 30 分以内の持ち主と Partner の発言（最大 4 件）、anchor、続く Partner の返事。
 * 持ち主以外の人の発言は塊に入れず、その人への返事も anchor にしない。
 */
export const buildChunks = (
	messages: readonly ChunkMessage[],
	ownerId: string,
): Chunk[] => {
	const ordered = [...messages].sort((a, b) => time(a) - time(b));
	const chunks: Chunk[] = [];
	ordered.forEach((anchor, i) => {
		if (!isOwner(anchor, ownerId) || !ordered[i + 1]?.isPartner) return;
		const before: ChunkMessage[] = [];
		for (let j = i - 1; j >= 0 && before.length < CHUNK_CONTEXT_COUNT; j--) {
			const m = ordered[j];
			if (!m || time(anchor) - time(m) > CHUNK_CONTEXT_WINDOW_MS) break;
			if (m.isPartner || isOwner(m, ownerId)) before.unshift(m);
		}
		const replies: ChunkMessage[] = [];
		for (let j = i + 1; ordered[j]?.isPartner; j++) {
			const m = ordered[j];
			if (m) replies.push(m);
		}
		chunks.push(toChunk(anchor.id, anchor, [...before, anchor, ...replies]));
	});
	return chunks;
};

const messageColumns = {
	id: conversationMessages.id,
	authorId: conversationMessages.authorId,
	authorName: conversationMessages.authorName,
	isPartner: conversationMessages.isPartner,
	content: conversationMessages.content,
	occurredAt: conversationMessages.occurredAt,
};

const chunkKey = (id: string): IndexKey => ({
	kind: "conversation",
	sourceId: id,
});

const saveChunks = async (
	db: DrizzleD1Database,
	partnerId: string,
	channelId: string,
	chunks: readonly Chunk[],
): Promise<void> => {
	// 1 回の batch を小さく保つ。1 つの塊は 3 文。
	for (const part of chunked(chunks, 30)) {
		const statements = part.flatMap((c) => {
			const row = {
				body: c.body,
				startedAt: c.startedAt,
				occurredAt: c.occurredAt,
				endedAt: c.endedAt,
			};
			return [
				db
					.insert(conversationChunks)
					.values({ id: c.id, partnerId, channelId, ...row })
					.onConflictDoUpdate({ target: conversationChunks.id, set: row }),
				db
					.delete(conversationChunkMessages)
					.where(eq(conversationChunkMessages.chunkId, c.id)),
				db
					.insert(conversationChunkMessages)
					.values(c.members.map((m) => ({ chunkId: c.id, messageId: m.id }))),
			] as const;
		});
		const [first, ...rest] = statements;
		if (first) await db.batch([first, ...rest]);
	}
};

/**
 * 返事をしたターンの会話を塊にする。anchor（受信した発言）が持ち主のものでなければ何もしない。
 * conversation_messages に書いた後に呼ぶ。索引を更新すべき塊を返す。
 */
export const indexTurnConversation = async (
	db: DrizzleD1Database,
	turn: {
		partnerId: string;
		channelId: string;
		ownerId: string;
		/** 受信した発言の Discord の message id。 */
		anchorMessageId: string;
		/** 文脈・受信・返事の Discord の message id（Partner の発言は仮 ID）。 */
		messageIds: readonly string[];
	},
): Promise<Result<IndexKey[], MemoryIndexError>> => {
	try {
		const rows: (ChunkMessage & { messageId: string })[] = [];
		for (const part of chunked(turn.messageIds, D1_PARAM_CHUNK)) {
			rows.push(
				...(await db
					.select({
						...messageColumns,
						messageId: conversationMessages.messageId,
					})
					.from(conversationMessages)
					.where(
						and(
							eq(conversationMessages.partnerId, turn.partnerId),
							eq(conversationMessages.channelId, turn.channelId),
							inArray(conversationMessages.messageId, part),
						),
					)),
			);
		}
		// 返事の時刻が受信と同じになりうるので、同時刻はターンの並び順で決める（buildChunks の sort は安定）。
		const order = new Map(turn.messageIds.map((id, i) => [id, i]));
		rows.sort(
			(a, b) => (order.get(a.messageId) ?? 0) - (order.get(b.messageId) ?? 0),
		);
		const anchor = rows.find((r) => r.messageId === turn.anchorMessageId);
		const chunk = anchor
			? buildChunks(rows, turn.ownerId).find((c) => c.id === anchor.id)
			: undefined;
		if (!chunk) return ok([]);
		await saveChunks(db, turn.partnerId, turn.channelId, [chunk]);
		return ok([chunkKey(chunk.id)]);
	} catch (e) {
		return err({ type: "storage_failed", message: errorMessage(e) });
	}
};

/** 会話ログのあるチャンネルを id 順に返す。 */
export const listLoggedChannels = async (
	db: DrizzleD1Database,
	partnerId: string,
): Promise<string[]> =>
	(
		await db
			.selectDistinct({ channelId: conversationMessages.channelId })
			.from(conversationMessages)
			.where(eq(conversationMessages.partnerId, partnerId))
			.orderBy(asc(conversationMessages.channelId))
	).map((r) => r.channelId);

/** チャンネルの会話ログ全体から塊を作り直す。既存データの一括投入に使う。 */
export const rebuildChannelChunks = async (
	db: DrizzleD1Database,
	q: { partnerId: string; channelId: string; ownerId: string },
): Promise<Result<IndexKey[], MemoryIndexError>> => {
	try {
		const rows = await db
			.select(messageColumns)
			.from(conversationMessages)
			.where(
				and(
					eq(conversationMessages.partnerId, q.partnerId),
					eq(conversationMessages.channelId, q.channelId),
				),
			)
			// 同時刻の発言は書き込んだ順（受信、返事の順）に並べる。
			.orderBy(asc(conversationMessages.occurredAt), sql`rowid`);
		const chunks = buildChunks(rows, q.ownerId);
		await saveChunks(db, q.partnerId, q.channelId, chunks);
		return ok(chunks.map((c) => chunkKey(c.id)));
	} catch (e) {
		return err({ type: "storage_failed", message: errorMessage(e) });
	}
};

/**
 * 会話ログの行を塊から外す。anchor が消えた塊は消し、それ以外は残りの発言で作り直す。
 * conversation_messages の行を消す前でも後でも呼べる。索引を更新すべき塊を返す。
 */
export const detachConversationMessages = async (
	db: DrizzleD1Database,
	messageIds: readonly string[],
): Promise<
	Result<
		{ keys: IndexKey[]; removedChunks: number; rebuiltChunks: number },
		MemoryIndexError
	>
> => {
	try {
		const removedIds = new Set(messageIds);
		const affected = new Set<string>();
		for (const part of chunked([...removedIds], D1_PARAM_CHUNK)) {
			const links = await db
				.select({ chunkId: conversationChunkMessages.chunkId })
				.from(conversationChunkMessages)
				.where(inArray(conversationChunkMessages.messageId, part));
			for (const l of links) affected.add(l.chunkId);
		}
		let removedChunks = 0;
		let rebuiltChunks = 0;
		for (const chunkId of affected) {
			const members = (
				await db
					.select(messageColumns)
					.from(conversationChunkMessages)
					.innerJoin(
						conversationMessages,
						eq(conversationMessages.id, conversationChunkMessages.messageId),
					)
					.where(eq(conversationChunkMessages.chunkId, chunkId))
			)
				.filter((m) => !removedIds.has(m.id))
				.sort((a, b) => time(a) - time(b));
			const anchor = members.find((m) => m.id === chunkId);
			if (!anchor) {
				await db.batch([
					db
						.delete(conversationChunks)
						.where(eq(conversationChunks.id, chunkId)),
					db
						.delete(conversationChunkMessages)
						.where(eq(conversationChunkMessages.chunkId, chunkId)),
				]);
				removedChunks++;
				continue;
			}
			const chunk = toChunk(chunkId, anchor, members);
			const [row] = await db
				.select({
					partnerId: conversationChunks.partnerId,
					channelId: conversationChunks.channelId,
				})
				.from(conversationChunks)
				.where(eq(conversationChunks.id, chunkId));
			if (!row) continue;
			await saveChunks(db, row.partnerId, row.channelId, [chunk]);
			rebuiltChunks++;
		}
		return ok({
			keys: [...affected].map(chunkKey),
			removedChunks,
			rebuiltChunks,
		});
	} catch (e) {
		return err({ type: "storage_failed", message: errorMessage(e) });
	}
};
