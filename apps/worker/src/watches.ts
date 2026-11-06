import type { WatchStore, WatchStoreError } from "@yunomi/capabilities";
import { err, newId, ok, type Result } from "@yunomi/core";
import { and, asc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { watches } from "./db/schema.ts";
import { findDiscordEntity } from "./work-notes.ts";

/** 1 人が同時に持てる見張りの数。見回りのたびに時間が来たものを全部調べるので、増えすぎないようにする。 */
export const ACTIVE_WATCH_LIMIT = 10;
/** 前に知らせたものとして覚えておく数。古いものから忘れる。 */
export const WATCH_SEEN_LIMIT = 100;
export const WATCH_SEEN_KEY_MAX_LENGTH = 200;

export type Watch = {
	id: string;
	query: string;
	sources: string[];
	intervalMinutes: number;
	untilAt: Date | null;
	seen: string[];
	lastCheckedAt: Date | null;
	createdAt: Date;
	/** 前に調べてから間隔が過ぎていて、今調べる番か。 */
	due: boolean;
};

export type WatchRepo = {
	add(input: {
		partnerId: string;
		entityId: string;
		query: string;
		sources: readonly string[];
		intervalMinutes: number;
		untilAt: Date | null;
		now: Date;
	}): Promise<Result<{ id: string }, { type: "duplicate" | "limit" }>>;
	/** 動いている見張りを止める。対象が無い（別の人の見張り、止め済み）なら null。 */
	stop(input: {
		partnerId: string;
		entityId: string;
		id: string;
		now: Date;
	}): Promise<{ id: string; query: string } | null>;
	/** 動いている見張りを古い順に。期限を過ぎたものは含めない。 */
	active(partnerId: string, entityId: string, now: Date): Promise<Watch[]>;
	/** 調べ終えたことと、知らせたものを残す。対象が無ければ false。 */
	recordCheck(input: {
		partnerId: string;
		entityId: string;
		id: string;
		seen: readonly string[];
		now: Date;
	}): Promise<boolean>;
};

const parseList = (raw: string): string[] => {
	try {
		const xs: unknown = JSON.parse(raw);
		return Array.isArray(xs)
			? xs.filter((x): x is string => typeof x === "string")
			: [];
	} catch {
		return [];
	}
};

const dateOrNull = (iso: string | null) =>
	iso === null ? null : new Date(iso);

export const createWatchRepo = (db: DrizzleD1Database): WatchRepo => {
	const activeRows = (partnerId: string, entityId: string) =>
		and(
			eq(watches.partnerId, partnerId),
			eq(watches.entityId, entityId),
			eq(watches.status, "active"),
		);

	const active = async (
		partnerId: string,
		entityId: string,
		now: Date,
	): Promise<Watch[]> => {
		const rows = await db
			.select()
			.from(watches)
			.where(activeRows(partnerId, entityId))
			.orderBy(asc(watches.createdAt), asc(watches.id));
		return rows.flatMap((r) => {
			const untilAt = dateOrNull(r.untilAt);
			if (untilAt !== null && untilAt.getTime() <= now.getTime()) return [];
			const lastCheckedAt = dateOrNull(r.lastCheckedAt);
			return [
				{
					id: r.id,
					query: r.query,
					sources: parseList(r.sources),
					intervalMinutes: r.intervalMinutes,
					untilAt,
					seen: parseList(r.seen),
					lastCheckedAt,
					createdAt: new Date(r.createdAt),
					due:
						lastCheckedAt === null ||
						now.getTime() - lastCheckedAt.getTime() >=
							r.intervalMinutes * 60_000,
				},
			];
		});
	};

	return {
		async add({
			partnerId,
			entityId,
			query,
			sources,
			intervalMinutes,
			untilAt,
			now,
		}) {
			const current = await active(partnerId, entityId, now);
			if (current.some((w) => w.query === query)) {
				return err({ type: "duplicate" });
			}
			if (current.length >= ACTIVE_WATCH_LIMIT) return err({ type: "limit" });
			const id = newId();
			await db.insert(watches).values({
				id,
				partnerId,
				entityId,
				query,
				sources: JSON.stringify(sources),
				intervalMinutes,
				untilAt: untilAt?.toISOString() ?? null,
				status: "active",
				seen: "[]",
				createdAt: now.toISOString(),
			});
			return ok({ id });
		},

		async stop({ partnerId, entityId, id, now }) {
			const [row] = await db
				.update(watches)
				.set({ status: "stopped", stoppedAt: now.toISOString() })
				.where(and(activeRows(partnerId, entityId), eq(watches.id, id)))
				.returning({ id: watches.id, query: watches.query });
			return row ?? null;
		},

		active,

		async recordCheck({ partnerId, entityId, id, seen, now }) {
			const [row] = await db
				.select({ seen: watches.seen })
				.from(watches)
				.where(and(activeRows(partnerId, entityId), eq(watches.id, id)));
			if (!row) return false;
			const before = parseList(row.seen);
			const added = [...new Set(seen)].filter((k) => !before.includes(k));
			const next = [...before, ...added].slice(-WATCH_SEEN_LIMIT);
			await db
				.update(watches)
				.set({ seen: JSON.stringify(next), lastCheckedAt: now.toISOString() })
				.where(eq(watches.id, id));
			return true;
		},
	};
};

/** Talking の道具（watch_add / watch_stop）が書く先。話し手の Discord user id から entity を引く。 */
export const createWatchStore = (db: DrizzleD1Database): WatchStore => {
	const repo = createWatchRepo(db);
	const withEntity = async <T>(
		discordUserId: string,
		f: (entityId: string) => Promise<Result<T, WatchStoreError>>,
	): Promise<Result<T, WatchStoreError>> => {
		try {
			const entityId = await findDiscordEntity(db, discordUserId);
			// ターンの最初に entity を作ってあるので、ここで無いのは D1 の不整合
			if (entityId === null) return err({ type: "unavailable" });
			return await f(entityId);
		} catch {
			return err({ type: "unavailable" });
		}
	};
	return {
		add: ({ discordUserId, ...rest }) =>
			withEntity(discordUserId, (entityId) => repo.add({ ...rest, entityId })),
		stop: ({ discordUserId, ...rest }) =>
			withEntity(discordUserId, async (entityId) => {
				const r = await repo.stop({ ...rest, entityId });
				return r === null ? err({ type: "not_found" }) : ok(r);
			}),
	};
};
