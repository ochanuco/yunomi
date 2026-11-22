import { parseWatchAdd } from "@yunomi/capabilities";
import { err, ok, type Result, toModelJson } from "@yunomi/core";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { authenticate } from "./auth/access.ts";
import { accessEnv } from "./env.ts";
import { createMemoryRepo } from "./memory.ts";
import { vectorDepsFromEnv, vectorSyncListener } from "./memory-index/index.ts";
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
import {
	createWorkingEventRepo,
	workingDoneStatuses,
	workingEventKinds,
} from "./working-events.ts";

export const WORKING_MEMORY_PATH = /^\/v1\/partners\/([^/]+)\/working\/memory$/;
export const WORKING_EVENTS_PATH = /^\/v1\/partners\/([^/]+)\/working\/events$/;

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

// 席が持ち主に頼まれた見張りを足す。watch の中身は Talking の watch_add と同じ検証（parseWatchAdd）に通す。
const watchAddSchema = v.object({
	discord_user_id: v.pipe(v.string(), v.nonEmpty()),
	watch: v.looseObject({}),
	/** 登録した席の投稿。新着をそこに書く。 */
	notify_thread_id: v.optional(v.pipe(v.string(), v.regex(/^\d{1,25}$/))),
});

const postSchema = v.union([writeSchema, watchAddSchema]);

const patchSchema = v.union([
	v.object({
		discord_user_id: v.pipe(v.string(), v.nonEmpty()),
		id: v.pipe(v.string(), v.nonEmpty()),
		status: v.picklist(goalClosings),
	}),
	v.object({
		discord_user_id: v.pipe(v.string(), v.nonEmpty()),
		watch_id: v.pipe(v.string(), v.trim(), v.nonEmpty()),
		status: v.literal("stopped"),
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
 * GET で読み、POST で 1 件（記録か見張り）足し、PATCH で目標を閉じるか見張りを止めるか調べ終えたことを残す。
 */
export async function handleWorkingMemory(
	request: Request,
	env: Env,
	partnerId: string,
	background: (task: Promise<void>) => void,
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
			createMemoryRepo(db).topFacts(partnerId, entityId, new Date()),
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
				schedule: w.schedule,
				until_at: w.untilAt,
				last_checked_at: w.lastCheckedAt,
				due: w.due,
				seen: w.seen,
				notify_thread_id: w.notifyThreadId,
			})),
		});
	}

	const notes = createWorkNoteRepo(
		db,
		vectorSyncListener(db, vectorDepsFromEnv(env), background),
	);
	if (request.method === "PATCH") {
		const parsed = await readJson(request, patchSchema);
		if (!parsed.ok) return parsed.error;
		const entityId = await findEntity(db, parsed.value.discord_user_id);
		if (!entityId) return error(404, "unknown_entity");
		if ("watch_id" in parsed.value && "status" in parsed.value) {
			const stopped = await createWatchRepo(db).stop({
				partnerId,
				entityId,
				id: parsed.value.watch_id,
				now: new Date(),
			});
			if (!stopped) return error(404, "unknown_watch");
			return json({ id: stopped.id, query: stopped.query, stopped: true });
		}
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

	const parsed = await readJson(request, postSchema);
	if (!parsed.ok) return parsed.error;
	const entityId = await findEntity(db, parsed.value.discord_user_id);
	if (!entityId) return error(404, "unknown_entity");
	const now = new Date();
	if ("watch" in parsed.value) {
		const watch = parseWatchAdd(parsed.value.watch, now);
		if (!watch.ok) {
			const issues =
				watch.error.type === "ValidationFailed" ? watch.error.issues : [];
			return error(400, "validation_failed", issues.join(", "));
		}
		const added = await createWatchRepo(db).add({
			partnerId,
			entityId,
			...watch.value,
			notifyThreadId: parsed.value.notify_thread_id ?? null,
			now,
		});
		if (!added.ok) {
			return added.error.type === "duplicate"
				? error(409, "duplicate_watch")
				: error(409, "watch_limit");
		}
		return json(
			{
				id: added.value.id,
				query: watch.value.query,
				sources: watch.value.sources,
				interval_minutes: watch.value.intervalMinutes,
				schedule: watch.value.schedule,
				until_at: watch.value.untilAt,
			},
			201,
		);
	}
	const { kind, summary } = parsed.value;
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

// Talking の prompt では 1 席が 1 行に並ぶため、件名と要旨に改行を入れさせない。
const oneLine = (max: number) =>
	v.pipe(
		v.string(),
		v.trim(),
		v.nonEmpty(),
		v.maxLength(max),
		v.regex(/^[^\r\n]*$/),
	);

const eventSchema = v.pipe(
	v.object({
		thread_id: v.pipe(v.string(), v.regex(/^\d{1,25}$/)),
		title: oneLine(100),
		event: v.picklist(workingEventKinds),
		status: v.nullish(v.picklist(workingDoneStatuses)),
		summary: v.nullish(oneLine(200)),
		at: v.pipe(
			v.string(),
			v.isoTimestamp(),
			v.check((s) => !Number.isNaN(Date.parse(s))),
			v.transform((s) => new Date(s)),
		),
	}),
	v.forward(
		v.check(
			(b) => (b.event === "done") === (b.status != null),
			"done のときだけ status を付ける",
		),
		["status"],
	),
);

/**
 * Working の席の出来事（始めた・判断を仰いだ・終えた・失敗した）を受ける口。席ごとに最新の 1 件だけを持ち、
 * Talking はオーナーが話し相手のターンに「今の仕事」として読む。届いたことでターンは起こさない。
 */
export async function handleWorkingEvents(
	request: Request,
	env: Env,
	partnerId: string,
): Promise<Response> {
	if (request.method !== "POST") return error(405, "method_not_allowed");
	const auth = await authenticate(request, accessEnv(env));
	if (!auth.ok) return error(auth.failure.status, auth.failure.error);
	if (
		auth.principal.kind !== "service" ||
		auth.principal.caller !== "working"
	) {
		return error(403, "forbidden");
	}
	if (!partnerProfile(partnerId)) return error(404, "unknown_partner");
	const parsed = await readJson(request, eventSchema);
	if (!parsed.ok) return parsed.error;
	const b = parsed.value;
	await createWorkingEventRepo(drizzle(env.DB)).record({
		partnerId,
		threadId: b.thread_id,
		title: b.title,
		event: b.event,
		status: b.status ?? null,
		summary: b.summary ?? null,
		at: b.at,
		now: new Date(),
	});
	return new Response(null, { status: 204 });
}
