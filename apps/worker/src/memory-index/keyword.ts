import { err, ok, type Result } from "@yunomi/core";
import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { errorMessage, type IndexKey, type MemoryIndexError } from "./types.ts";
import type { SearchQuery } from "./vectors.ts";

/** trigram は 3 文字に満たない語を引けない。 */
export const MIN_TERM_LENGTH = 3;

/**
 * 空白で区切った語のうち 3 文字以上を、いずれかを含む文書を探す MATCH 式にする。
 * 語は引用して FTS5 の演算子として解釈させない。
 */
export const toMatchExpression = (text: string): string | null => {
	const terms = text
		.split(/\s+/)
		.filter((t) => [...t].length >= MIN_TERM_LENGTH)
		.map((t) => `"${t.replaceAll('"', '""')}"`);
	return terms.length > 0 ? [...new Set(terms)].join(" OR ") : null;
};

export type KeywordHit = IndexKey & {
	at: Date;
	/** bm25。小さいほど一致が強い。 */
	score: number;
};

/** キーワード検索の top-k。引ける語が無ければ空を返す。 */
export const searchKeywords = async (
	db: DrizzleD1Database,
	q: SearchQuery,
): Promise<Result<KeywordHit[], MemoryIndexError>> => {
	const match = toMatchExpression(q.text);
	if (match === null) return ok([]);
	const conditions = [
		sql`memory_search_fts MATCH ${match}`,
		sql`d.partner_id = ${q.partnerId}`,
	];
	if (q.kinds) {
		conditions.push(
			sql`d.kind IN (${sql.join(
				q.kinds.map((k) => sql`${k}`),
				sql`, `,
			)})`,
		);
	}
	// at は toISOString の形で揃えてあるので、文字列の比較で範囲を引ける。
	if (q.from) conditions.push(sql`d.at >= ${q.from.toISOString()}`);
	if (q.to) conditions.push(sql`d.at < ${q.to.toISOString()}`);
	try {
		const rows = await db.all<{
			kind: IndexKey["kind"];
			source_id: string;
			at: string;
			score: number;
		}>(sql`
			SELECT d.kind, d.source_id, d.at, bm25(memory_search_fts) AS score
			FROM memory_search_fts
			JOIN memory_search_docs d ON d.id = memory_search_fts.rowid
			WHERE ${sql.join(conditions, sql` AND `)}
			ORDER BY score
			LIMIT ${q.topK}
		`);
		return ok(
			rows.map((r) => ({
				kind: r.kind,
				sourceId: r.source_id,
				at: new Date(r.at),
				score: r.score,
			})),
		);
	} catch (e) {
		return err({ type: "storage_failed", message: errorMessage(e) });
	}
};
