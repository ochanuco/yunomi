import { toModelJson } from "@yunomi/core";
import { and, eq } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { authenticate } from "./auth/access.ts";
import { externalIdentities } from "./db/schema.ts";
import { accessEnv } from "./env.ts";
import { createMemoryRepo } from "./memory.ts";
import { createOpenLoopRepo } from "./open-loops.ts";
import { partnerProfile } from "./partners.ts";
import {
	createWorkNoteRepo,
	WORK_NOTE_SUMMARY_MAX_LENGTH,
	workNoteKinds,
} from "./work-notes.ts";

export const WORKING_MEMORY_PATH = /^\/v1\/partners\/([^/]+)\/working\/memory$/;

const writeSchema = v.object({
	discord_user_id: v.pipe(v.string(), v.nonEmpty()),
	kind: v.picklist(workNoteKinds),
	summary: v.pipe(
		v.string(),
		v.trim(),
		v.nonEmpty(),
		v.maxLength(WORK_NOTE_SUMMARY_MAX_LENGTH),
		// Talking の記憶では1件が1行に並ぶため、改行を入れると前後の行と混ざる。
		v.regex(/^[^\r\n]*$/),
	),
});

const json = (body: unknown, status = 200) =>
	new Response(toModelJson(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const error = (status: number, error: string, message?: string) =>
	Response.json(message ? { error, message } : { error }, { status });

/**
 * entity は Talking で話したことのある相手だけを引く。ここでは作らないので、
 * Working の読み書きで entities / external_identities に行が増えることはない。
 */
const findEntity = async (db: DrizzleD1Database, discordUserId: string) => {
	const [row] = await db
		.select({ entityId: externalIdentities.entityId })
		.from(externalIdentities)
		.where(
			and(
				eq(externalIdentities.provider, "discord"),
				eq(externalIdentities.externalId, discordUserId),
			),
		);
	return row?.entityId ?? null;
};

/**
 * Working（仕事）のパートナーが Talking と同じ記憶を読み書きする口。
 * 会話の処理（DO の turn）を通さず D1 だけを触るので、関係性・興味・意見・直近の会話履歴は動かない。
 */
export async function handleWorkingMemory(
	request: Request,
	env: Env,
	partnerId: string,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "POST") {
		return error(405, "method_not_allowed");
	}
	const auth = await authenticate(request, accessEnv(env));
	if (!auth.ok) return error(auth.failure.status, auth.failure.error);
	if (
		auth.principal.kind !== "service" ||
		auth.principal.caller !== "working"
	) {
		return error(403, "forbidden");
	}
	if (!partnerProfile(partnerId)) {
		return error(404, "unknown_partner");
	}
	const db = drizzle(env.DB);

	if (request.method === "GET") {
		const discordUserId = new URL(request.url).searchParams.get(
			"discord_user_id",
		);
		if (!discordUserId) {
			return error(400, "validation_failed", "discord_user_id");
		}
		const entityId = await findEntity(db, discordUserId);
		if (!entityId) return error(404, "unknown_entity");
		const [memory, openLoops] = await Promise.all([
			createMemoryRepo(db).topFacts(partnerId, entityId),
			createOpenLoopRepo(db).topOpen(partnerId, entityId),
		]);
		const line = (f: (typeof memory)[number]) => ({
			predicate: f.predicate,
			object: f.object,
			observed_at: f.observedAt,
		});
		return json({
			facts: memory.filter((f) => f.kind === "lasting").map(line),
			episodes: memory.filter((f) => f.kind === "episode").map(line),
			open_loops: openLoops.map((l) => ({
				id: l.id,
				summary: l.summary,
				due_at: l.dueAt,
			})),
		});
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return error(400, "invalid_json");
	}
	const parsed = v.safeParse(writeSchema, body);
	if (!parsed.success) {
		return error(
			400,
			"validation_failed",
			parsed.issues.map((i) => v.getDotPath(i) ?? i.message).join(", "),
		);
	}
	const entityId = await findEntity(db, parsed.output.discord_user_id);
	if (!entityId) return error(404, "unknown_entity");
	const note = await createWorkNoteRepo(db).add({
		partnerId,
		entityId,
		kind: parsed.output.kind,
		summary: parsed.output.summary,
		now: new Date(),
	});
	return json(
		{
			id: note.id,
			kind: note.kind,
			summary: note.summary,
			created_at: note.createdAt,
		},
		201,
	);
}
