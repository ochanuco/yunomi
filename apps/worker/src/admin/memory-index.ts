import {
	MemoryIndexRebuildRequestSchema,
	type MemoryIndexRebuildResponse,
} from "@yunomi/admin-contract";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import {
	listLoggedChannels,
	rebuildChannelChunks,
} from "../memory-index/chunks.ts";
import { reembedDocs, vectorDepsFromEnv } from "../memory-index/vectors.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

/** 1 回の呼び出しで埋め込む文書の数。Workers AI と Vectorize の呼び出しを 1 回ずつに収める。 */
export const REBUILD_VECTOR_BATCH = 50;

/**
 * `POST /partners/:id/memory-index`。既存データを索引に入れる。
 * 1 回で 1 チャンネル（chunks）か 50 文書（vectors）だけ進め、続きは next_cursor で呼び直させる。
 */
export async function handleMemoryIndexRebuild(
	request: Request,
	env: Env,
	partnerId: string,
): Promise<Response> {
	if (request.method !== "POST") return fail(405, "method_not_allowed");
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return fail(400, "invalid_json");
	}
	const parsed = v.safeParse(MemoryIndexRebuildRequestSchema, body);
	if (!parsed.success) return fail(400, "validation_failed");
	const { step, cursor } = parsed.output;
	const db = drizzle(env.DB);

	if (step === "chunks") {
		const ownerId = env.OWNER_DISCORD_USER_ID;
		if (!ownerId) {
			return json({
				step,
				processed: 0,
				next_cursor: null,
				skipped: "owner_unknown",
			} satisfies MemoryIndexRebuildResponse);
		}
		const channels = await listLoggedChannels(db, partnerId);
		const channelId = channels.find((c) => cursor === null || c > cursor);
		if (channelId === undefined) {
			return json({
				step,
				processed: 0,
				next_cursor: null,
				skipped: null,
			} satisfies MemoryIndexRebuildResponse);
		}
		const built = await rebuildChannelChunks(db, {
			partnerId,
			channelId,
			ownerId,
		});
		if (!built.ok) return fail(500, built.error.type);
		const last = channelId === channels.at(-1);
		return json({
			step,
			processed: built.value.length,
			next_cursor: last ? null : channelId,
			skipped: null,
		} satisfies MemoryIndexRebuildResponse);
	}

	const vectors = vectorDepsFromEnv(env);
	if (!vectors) return fail(503, "memory_index_unavailable");
	const afterId = cursor === null ? 0 : Number(cursor);
	if (!Number.isInteger(afterId) || afterId < 0) {
		return fail(400, "invalid_cursor");
	}
	const r = await reembedDocs(db, vectors, {
		partnerId,
		afterId,
		limit: REBUILD_VECTOR_BATCH,
	});
	if (!r.ok) return fail(500, r.error.type);
	return json({
		step,
		processed: r.value.processed,
		next_cursor:
			r.value.processed < REBUILD_VECTOR_BATCH || r.value.lastId === null
				? null
				: String(r.value.lastId),
		skipped: null,
	} satisfies MemoryIndexRebuildResponse);
}
