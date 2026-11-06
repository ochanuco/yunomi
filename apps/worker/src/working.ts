import { err, ok, type Result, toModelJson } from "@yunomi/core";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { authenticate } from "./auth/access.ts";
import { accessEnv } from "./env.ts";
import { createMemoryRepo } from "./memory.ts";
import { createOpenLoopRepo } from "./open-loops.ts";
import { partnerProfile } from "./partners.ts";
import {
	createWatchRepo,
	WATCH_SEEN_KEY_MAX_LENGTH,
	WATCH_SEEN_LIMIT,
} from "./watches.ts";
import {
	createWorkNoteRepo,
	findDiscordEntity as findEntity,
	goalClosings,
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

const patchSchema = v.union([
	v.object({
		discord_user_id: v.pipe(v.string(), v.nonEmpty()),
		id: v.pipe(v.string(), v.nonEmpty()),
		status: v.picklist(goalClosings),
	}),
	// 見回りの席が見張りを調べ終えたときに送る。seen は今回知らせたものの key。
	v.object({
		discord_user_id: v.pipe(v.string(), v.nonEmpty()),
		watch_id: v.pipe(v.string(), v.nonEmpty()),
		seen: v.pipe(
			v.array(
				v.pipe(
					v.string(),
					v.trim(),
					v.nonEmpty(),
					v.maxLength(WATCH_SEEN_KEY_MAX_LENGTH),
				),
			),
			v.maxLength(WATCH_SEEN_LIMIT),
		),
	}),
]);

const json = (body: unknown, status = 200) =>
	new Response(toModelJson(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const error = (status: number, error: string, message?: string) =>
	Response.json(message ? { error, message } : { error }, { status });

const readJson = async <T>(
	request: Request,
	schema: v.GenericSchema<unknown, T>,
): Promise<Result<T, Response>> => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return err(error(400, "invalid_json"));
	}
	const parsed = v.safeParse(schema, body);
	if (!parsed.success) {
		return err(
			error(
				400,
				"validation_failed",
				parsed.issues.map((i) => v.getDotPath(i) ?? i.message).join(", "),
			),
		);
	}
	return ok(parsed.output);
};

/**
 * Working（仕事）のパートナーが Talking と同じ記憶を読み書きする口。
 * 会話の処理（DO の turn）を通さず D1 だけを触るので、関係性・興味・意見・直近の会話履歴は動かない。
 * GET で読み、POST で 1 件足し、PATCH で目標を閉じる。
 */
export async function handleWorkingMemory(
	request: Request,
	env: Env,
	partnerId: string,
): Promise<Response> {
	if (
		request.method !== "GET" &&
		request.method !== "POST" &&
		request.method !== "PATCH"
	) {
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
		const [memory, openLoops, goals, watches] = await Promise.all([
			createMemoryRepo(db).topFacts(partnerId, entityId),
			createOpenLoopRepo(db).topOpen(partnerId, entityId),
			createWorkNoteRepo(db).openGoals(partnerId, entityId),
			createWatchRepo(db).active(partnerId, entityId, new Date()),
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
			goals: goals.map((g) => ({
				id: g.id,
				summary: g.summary,
				created_at: g.createdAt,
			})),
			watches: watches.map((w) => ({
				id: w.id,
				query: w.query,
				sources: w.sources,
				interval_minutes: w.intervalMinutes,
				until_at: w.untilAt,
				last_checked_at: w.lastCheckedAt,
				due: w.due,
				seen: w.seen,
			})),
		});
	}

	const notes = createWorkNoteRepo(db);
	if (request.method === "PATCH") {
		const parsed = await readJson(request, patchSchema);
		if (!parsed.ok) return parsed.error;
		const entityId = await findEntity(db, parsed.value.discord_user_id);
		if (!entityId) return error(404, "unknown_entity");
		if ("watch_id" in parsed.value) {
			const recorded = await createWatchRepo(db).recordCheck({
				partnerId,
				entityId,
				id: parsed.value.watch_id,
				seen: parsed.value.seen,
				now: new Date(),
			});
			if (!recorded) return error(404, "unknown_watch");
			return json({ id: parsed.value.watch_id, checked: true });
		}
		const goal = await notes.closeGoal({
			partnerId,
			entityId,
			id: parsed.value.id,
			status: parsed.value.status,
			now: new Date(),
		});
		if (!goal) return error(404, "unknown_goal");
		return json({
			id: goal.id,
			summary: goal.summary,
			status: parsed.value.status,
		});
	}

	const parsed = await readJson(request, writeSchema);
	if (!parsed.ok) return parsed.error;
	const { discord_user_id, kind, summary } = parsed.value;
	const entityId = await findEntity(db, discord_user_id);
	if (!entityId) return error(404, "unknown_entity");
	const now = new Date();
	if (kind === "goal") {
		const added = await notes.openGoal({ partnerId, entityId, summary, now });
		if (!added.ok) {
			return added.error.type === "duplicate"
				? error(409, "duplicate_goal")
				: error(409, "goal_limit");
		}
		return json(
			{
				id: added.value.id,
				kind,
				summary,
				created_at: added.value.createdAt,
			},
			201,
		);
	}
	const note = await notes.add({ partnerId, entityId, kind, summary, now });
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
