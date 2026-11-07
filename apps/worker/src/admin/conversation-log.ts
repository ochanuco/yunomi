import {
	type ConversationLogDeleteRequest,
	ConversationLogDeleteRequestSchema,
	type ConversationLogDeleteResponse,
} from "@yunomi/admin-contract";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import type { Principal } from "../auth/access.ts";
import {
	deleteConversationMessages,
	recordMaintenance,
} from "../conversation-log.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

// 比較は occurred_at の文字列順なので、オフセット付きの指定も UTC の Z 形式に揃える。
const utc = (iso: string | undefined) =>
	iso === undefined ? undefined : new Date(iso).toISOString();

/** `POST /partners/:id/conversation-log/delete`。認可は呼び出し元（handleAdminApi）で済ませる。 */
export async function handleConversationLogDelete(
	request: Request,
	env: Env,
	partnerId: string,
	principal: Principal,
	now: Date,
): Promise<Response> {
	if (request.method !== "POST") return fail(405, "method_not_allowed");
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return fail(400, "invalid_json");
	}
	const parsed = v.safeParse(ConversationLogDeleteRequestSchema, body);
	if (!parsed.success) {
		return json(
			{
				error: "validation_failed",
				message: parsed.issues[0]?.message ?? "",
			},
			400,
		);
	}
	const req: ConversationLogDeleteRequest = parsed.output;
	const from = utc(req.from);
	const to = utc(req.to);
	if (from !== undefined && to !== undefined && from >= to) {
		return fail(400, "invalid_range");
	}
	const dryRun = req.dry_run ?? false;
	const db = drizzle(env.DB);
	const r = await deleteConversationMessages(
		db,
		{
			partnerId,
			from,
			to,
			channelId: req.channel_id,
			messageIds: req.message_ids,
		},
		{ dryRun },
	);
	if (!r.ok) return fail(400, r.error.type);
	const count = r.value.ids.length;
	if (!dryRun) {
		await recordMaintenance(db, {
			partnerId,
			kind: "conversation_log_delete",
			actor: principal.kind === "owner" ? "owner" : "ykm",
			deletedCount: count,
			now,
		});
	}
	return json({
		dry_run: dryRun,
		count,
	} satisfies ConversationLogDeleteResponse);
}
