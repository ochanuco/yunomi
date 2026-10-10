import { newId } from "@yunomi/core";
import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { entities, externalIdentities } from "../db/schema.ts";
import type { DoStore } from "./store.ts";

export type EntityResolver = {
	resolve(
		provider: string,
		externalId: string,
		displayName: string,
	): Promise<string>;
};

/**
 * 外部 ID（Discord user id など）を内部の entity ID に解決する。
 * 一度解決した対応は不変なので DO 内にキャッシュし、以降は D1 を引かない。
 */
export const createEntityResolver = (
	db: DrizzleD1Database,
	store: DoStore,
	now: () => Date,
): EntityResolver => {
	// 別チャンネルの並行ターンが同じ作者を同時に作らないよう、解決中の Promise を共有する。
	const inflight = new Map<string, Promise<string>>();

	const lookup = async (provider: string, externalId: string) => {
		const [row] = await db
			.select({ entityId: externalIdentities.entityId })
			.from(externalIdentities)
			.where(
				and(
					eq(externalIdentities.provider, provider),
					eq(externalIdentities.externalId, externalId),
				),
			);
		return row?.entityId ?? null;
	};

	const create = async (
		provider: string,
		externalId: string,
		displayName: string,
	) => {
		const id = newId();
		await db.batch([
			db.insert(entities).values({
				id,
				kind: "human",
				displayName,
				createdAt: now().toISOString(),
			}),
			db
				.insert(externalIdentities)
				.values({ provider, externalId, entityId: id })
				.onConflictDoNothing(),
		]);
		// 競合で別の entity が先に紐づいていた場合はそちらを正とする。
		return (await lookup(provider, externalId)) ?? id;
	};

	return {
		async resolve(provider, externalId, displayName) {
			const cached = store.cachedEntity(provider, externalId);
			if (cached) return cached;
			const key = `${provider}:${externalId}`;
			let p = inflight.get(key);
			if (!p) {
				p = (async () => {
					const id =
						(await lookup(provider, externalId)) ??
						(await create(provider, externalId, displayName));
					store.cacheEntity(provider, externalId, id);
					return id;
				})().finally(() => inflight.delete(key));
				inflight.set(key, p);
			}
			return p;
		},
	};
};
