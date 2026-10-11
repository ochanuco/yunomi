import {
	SNAPSHOT_SCHEMA_VERSION,
	type SnapshotSummary,
} from "@yunomi/admin-contract";

export const SNAPSHOT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_SUFFIX = ".json.gz.age";
export const SNAPSHOT_ID_PATTERN = /^[0-9a-f-]{36}$/;

const prefix = (partnerId: string) => `snapshots/${partnerId}/`;

export const snapshotKey = (partnerId: string, snapshotId: string) =>
	`${prefix(partnerId)}${snapshotId}${KEY_SUFFIX}`;

export type StoredSnapshot = {
	id: string;
	partnerId: string;
	createdAt: string;
	env: string;
	bytes: Uint8Array;
};

export const putSnapshot = async (
	bucket: R2Bucket,
	s: StoredSnapshot,
): Promise<SnapshotSummary> => {
	await bucket.put(snapshotKey(s.partnerId, s.id), s.bytes, {
		customMetadata: {
			schema_version: String(SNAPSHOT_SCHEMA_VERSION),
			created_at: s.createdAt,
			env: s.env,
		},
	});
	return {
		id: s.id,
		created_at: s.createdAt,
		size: s.bytes.byteLength,
		schema_version: SNAPSHOT_SCHEMA_VERSION,
		env: s.env,
	};
};

const toSummary = (o: R2Object): SnapshotSummary => ({
	id: o.key.slice(o.key.lastIndexOf("/") + 1, -KEY_SUFFIX.length),
	created_at: o.customMetadata?.created_at ?? o.uploaded.toISOString(),
	size: o.size,
	schema_version: Number(o.customMetadata?.schema_version ?? 0),
	env: o.customMetadata?.env ?? "",
});

/** 新しい順。 */
export const listSnapshots = async (
	bucket: R2Bucket,
	partnerId: string,
): Promise<SnapshotSummary[]> => {
	const items: SnapshotSummary[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({
			prefix: prefix(partnerId),
			cursor,
			include: ["customMetadata"],
		});
		for (const o of page.objects) {
			if (o.key.endsWith(KEY_SUFFIX)) items.push(toSummary(o));
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return items.sort((a, b) => b.created_at.localeCompare(a.created_at));
};

export const getSnapshotObject = (
	bucket: R2Bucket,
	partnerId: string,
	snapshotId: string,
) => bucket.get(snapshotKey(partnerId, snapshotId));

/** 保持期間より古い Snapshot を削除し、消した件数を返す。 */
export const purgeExpiredSnapshots = async (
	bucket: R2Bucket,
	partnerId: string,
	now: Date,
): Promise<number> => {
	const cutoff = new Date(
		now.getTime() - SNAPSHOT_RETENTION_DAYS * DAY_MS,
	).toISOString();
	const expired = (await listSnapshots(bucket, partnerId)).filter(
		(s) => s.created_at < cutoff,
	);
	if (expired.length > 0) {
		await bucket.delete(expired.map((s) => snapshotKey(partnerId, s.id)));
	}
	return expired.length;
};
