import { newId } from "@yunomi/core";
import {
	type GithubEventsResponse,
	type GithubWorkEvent,
	githubWorkEventSchema,
} from "@yunomi/protocol";
import { lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { authenticate } from "./auth/access.ts";
import { githubEvents } from "./db/schema.ts";
import { accessEnv } from "./env.ts";

export const GITHUB_WEBHOOK_PATH = "/v1/github/webhook";

/** 席に渡す本文の上限。長いレビューは先頭だけで足り、残りは席が URL から読む。 */
const BODY_LIMIT = 2000;
/** これより古い出来事は Working に渡さない。Working が長く止まっていた分は見回りが拾う。 */
export const GITHUB_EVENT_MAX_AGE_MS = 6 * 60 * 60_000;
/** Working が取りに来ないまま残った行を消す。 */
const RETENTION_MS = 24 * 60 * 60_000;

/** prod だけが持つ。無ければ webhook の口を閉じる。 */
export type GithubWebhookEnv = { GITHUB_WEBHOOK_SECRET?: string };

const hexToBytes = (hex: string) => {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
};

/** `X-Hub-Signature-256` を確かめる。subtle.verify は比較の時間が中身によらない。 */
export const verifySignature = async (
	secret: string,
	body: ArrayBuffer,
	header: string | null,
): Promise<boolean> => {
	const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header ?? "");
	if (!m?.[1]) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify("HMAC", key, hexToBytes(m[1]), body);
};

const FAILED = ["failure", "timed_out", "startup_failure"];

const repository = v.object({ full_name: v.string() });
const user = v.object({ login: v.string(), type: v.optional(v.string()) });
const prRefs = v.array(v.object({ number: v.number() }));

const checkSuiteSchema = v.object({
	action: v.literal("completed"),
	check_suite: v.object({
		conclusion: v.nullable(v.string()),
		head_branch: v.nullable(v.string()),
		head_sha: v.string(),
		app: v.nullish(v.object({ slug: v.string(), name: v.string() })),
		pull_requests: prRefs,
	}),
	repository: v.object({ full_name: v.string(), html_url: v.string() }),
	sender: v.nullish(user),
});

const workflowRunSchema = v.object({
	action: v.literal("completed"),
	workflow_run: v.object({
		conclusion: v.nullable(v.string()),
		name: v.nullish(v.string()),
		head_branch: v.nullable(v.string()),
		html_url: v.string(),
		pull_requests: prRefs,
		triggering_actor: v.nullish(user),
	}),
	repository,
});

const reviewSchema = v.object({
	action: v.literal("submitted"),
	review: v.object({
		state: v.string(),
		body: v.nullable(v.string()),
		html_url: v.string(),
		user,
	}),
	pull_request: v.object({ number: v.number(), title: v.string() }),
	repository,
});

const commentSchema = v.object({
	action: v.literal("created"),
	comment: v.object({ body: v.string(), html_url: v.string(), user }),
	issue: v.object({
		number: v.number(),
		title: v.string(),
		pull_request: v.optional(v.unknown()),
	}),
	repository,
});

const clip = (s: string | null) => {
	const t = s ?? "";
	return t.length > BODY_LIMIT ? `${t.slice(0, BODY_LIMIT)}…` : t;
};

const isBot = (u: v.InferOutput<typeof user>) => u.type === "Bot";

/** 席を動かす出来事だけを抜き出す。それ以外（成功した CI、編集、削除など）は null。 */
export const toWorkEvent = (
	name: string,
	payload: unknown,
): GithubWorkEvent | null => {
	switch (name) {
		case "check_suite": {
			const p = v.safeParse(checkSuiteSchema, payload);
			if (!p.success) return null;
			const s = p.output.check_suite;
			// Actions の失敗は workflow_run で受ける。両方を受けると同じ失敗が二度来る
			if (s.app?.slug === "github-actions") return null;
			if (!s.conclusion || !FAILED.includes(s.conclusion)) return null;
			return {
				kind: "ci_failed",
				repo: p.output.repository.full_name,
				prs: s.pull_requests.map((x) => x.number),
				name: s.app?.name ?? "check_suite",
				branch: s.head_branch,
				conclusion: s.conclusion,
				url: `${p.output.repository.html_url}/commit/${s.head_sha}/checks`,
				actor: p.output.sender?.login ?? null,
			};
		}
		case "workflow_run": {
			const p = v.safeParse(workflowRunSchema, payload);
			if (!p.success) return null;
			const r = p.output.workflow_run;
			if (!r.conclusion || !FAILED.includes(r.conclusion)) return null;
			return {
				kind: "ci_failed",
				repo: p.output.repository.full_name,
				prs: r.pull_requests.map((x) => x.number),
				name: r.name ?? "workflow_run",
				branch: r.head_branch,
				conclusion: r.conclusion,
				url: r.html_url,
				actor: r.triggering_actor?.login ?? null,
			};
		}
		case "pull_request_review": {
			const p = v.safeParse(reviewSchema, payload);
			if (!p.success) return null;
			const r = p.output.review;
			return {
				kind: "review",
				repo: p.output.repository.full_name,
				pr: p.output.pull_request.number,
				title: p.output.pull_request.title,
				state: r.state,
				body: clip(r.body),
				url: r.html_url,
				actor: r.user.login,
				actor_is_bot: isBot(r.user),
			};
		}
		case "issue_comment": {
			const p = v.safeParse(commentSchema, payload);
			if (!p.success) return null;
			const c = p.output.comment;
			return {
				kind: "comment",
				repo: p.output.repository.full_name,
				number: p.output.issue.number,
				is_pr: p.output.issue.pull_request !== undefined,
				title: p.output.issue.title,
				body: clip(c.body),
				url: c.html_url,
				actor: c.user.login,
				actor_is_bot: isBot(c.user),
			};
		}
		default:
			return null;
	}
};

/**
 * GitHub の webhook を受ける口。Access を通らないので、署名だけで本物かを見る。
 * Working は公開していないため、ここでは D1 に置くだけにし、Working が取りに来る。
 */
export async function handleGithubWebhook(
	request: Request,
	env: Env & GithubWebhookEnv,
): Promise<Response> {
	const secret = env.GITHUB_WEBHOOK_SECRET;
	if (!secret) return Response.json({ error: "not_found" }, { status: 404 });
	if (request.method !== "POST") {
		return Response.json({ error: "method_not_allowed" }, { status: 405 });
	}
	const body = await request.arrayBuffer();
	const signed = await verifySignature(
		secret,
		body,
		request.headers.get("x-hub-signature-256"),
	);
	if (!signed)
		return Response.json({ error: "bad_signature" }, { status: 401 });

	const name = request.headers.get("x-github-event");
	const delivery = request.headers.get("x-github-delivery");
	if (!name || !delivery) {
		return Response.json({ error: "validation_failed" }, { status: 400 });
	}
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(body));
	} catch {
		return Response.json({ error: "invalid_json" }, { status: 400 });
	}
	const event = toWorkEvent(name, payload);
	if (event === null) return new Response(null, { status: 204 });

	await drizzle(env.DB)
		.insert(githubEvents)
		.values({
			id: newId(),
			deliveryId: delivery,
			event: JSON.stringify(event),
			receivedAt: new Date().toISOString(),
		})
		.onConflictDoNothing();
	return new Response(null, { status: 202 });
}

/** Working が溜まった出来事を取り出す。取り出した行は消すので、同じ出来事は一度しか渡らない。 */
export async function handleGithubEvents(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ error: "method_not_allowed" }, { status: 405 });
	}
	const auth = await authenticate(request, accessEnv(env));
	if (!auth.ok) {
		return Response.json(
			{ error: auth.failure.error },
			{ status: auth.failure.status },
		);
	}
	if (
		auth.principal.kind !== "service" ||
		auth.principal.caller !== "working"
	) {
		return Response.json({ error: "forbidden" }, { status: 403 });
	}
	const rows = await drizzle(env.DB).delete(githubEvents).returning();
	const since = Date.now() - GITHUB_EVENT_MAX_AGE_MS;
	const events: GithubEventsResponse["events"] = rows
		.filter((r) => Date.parse(r.receivedAt) >= since)
		.sort((a, b) => (a.id < b.id ? -1 : 1))
		.flatMap((r) => {
			const parsed = v.safeParse(githubWorkEventSchema, JSON.parse(r.event));
			return parsed.success
				? [{ id: r.id, received_at: r.receivedAt, event: parsed.output }]
				: [];
		});
	return Response.json({ events } satisfies GithubEventsResponse);
}

export const purgeStaleGithubEvents = async (db: D1Database, now: Date) => {
	await drizzle(db)
		.delete(githubEvents)
		.where(
			lt(
				githubEvents.receivedAt,
				new Date(now.getTime() - RETENTION_MS).toISOString(),
			),
		);
};
