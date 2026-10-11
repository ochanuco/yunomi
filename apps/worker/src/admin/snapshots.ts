import type {
	SnapshotRestoreResponse,
	SnapshotsResponse,
} from "@yunomi/admin-contract";
import { partnerNamespace } from "../env.ts";
import { createSnapshot, restoreSnapshot } from "../snapshot.ts";
import { parseSnapshot } from "../snapshot-codec.ts";
import {
	getSnapshotObject,
	listSnapshots,
	SNAPSHOT_ID_PATTERN,
} from "../snapshot-store.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

/** `/partners/:id/snapshots` 以降のパス。`""` は一覧・作成、`restore` は復元、それ以外は id。 */
export async function handleSnapshots(
	request: Request,
	env: Env,
	partnerId: string,
	rest: string,
): Promise<Response> {
	const partner = partnerNamespace(env);
	const stub = partner.get(partner.idFromName(partnerId));

	if (rest === "") {
		if (request.method === "GET") {
			const items = await listSnapshots(env.SNAPSHOTS, partnerId);
			return json({ items } satisfies SnapshotsResponse);
		}
		if (request.method !== "POST") return fail(405, "method_not_allowed");
		const created = await createSnapshot({
			db: env.DB,
			partner: stub,
			partnerId,
			env: env.YUNOMI_ENV,
			now: new Date(),
			bucket: env.SNAPSHOTS,
			recipient: env.SNAPSHOT_AGE_RECIPIENT,
		});
		return created.ok
			? json(created.value, 201)
			: fail(500, created.error.type);
	}

	if (rest === "restore") {
		if (request.method !== "POST") return fail(405, "method_not_allowed");
		// 本番の記憶を Snapshot で上書きさせない。
		if (env.YUNOMI_ENV === "production") {
			return fail(403, "restore_disabled_in_production");
		}
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return fail(400, "invalid_json");
		}
		const parsed = parseSnapshot(body);
		if (!parsed.ok) {
			return json({ error: "validation_failed", message: parsed.message }, 400);
		}
		const snapshot = parsed.value;
		const restored = await restoreSnapshot(
			{ db: env.DB, partner: stub, partnerId },
			snapshot,
		);
		if (!restored.ok) {
			return json(
				{ error: restored.error.type, message: restored.error.message },
				422,
			);
		}
		console.log(
			JSON.stringify({
				event: "snapshot_restore",
				partner_id: partnerId,
				snapshot_id: snapshot.snapshot_id,
				source_env: snapshot.env,
				counts: restored.value,
			}),
		);
		return json({
			snapshot_id: snapshot.snapshot_id,
			source_env: snapshot.env,
			counts: restored.value,
		} satisfies SnapshotRestoreResponse);
	}

	if (!SNAPSHOT_ID_PATTERN.test(rest)) return fail(404, "not_found");
	if (request.method !== "GET") return fail(405, "method_not_allowed");
	const object = await getSnapshotObject(env.SNAPSHOTS, partnerId, rest);
	if (!object) return fail(404, "snapshot_not_found");
	return new Response(object.body, {
		headers: {
			"content-type": "application/octet-stream",
			"content-length": String(object.size),
		},
	});
}
