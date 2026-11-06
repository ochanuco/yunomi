import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { toWorkEvent, verifySignature } from "../src/github-webhook.ts";

const SECRET = env.GITHUB_WEBHOOK_SECRET as string;
const WEBHOOK = "http://localhost/v1/github/webhook";
const EVENTS = "http://localhost/v1/working/github-events";

const sign = async (secret: string, body: string) => {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(body),
	);
	return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
};

let delivery = 0;
const deliver = async (
	event: string,
	payload: unknown,
	opts: { signature?: string | null; delivery?: string } = {},
) => {
	const body = JSON.stringify(payload);
	const signature =
		opts.signature === undefined ? await sign(SECRET, body) : opts.signature;
	delivery += 1;
	return exports.default.fetch(
		new Request(WEBHOOK, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-github-event": event,
				"x-github-delivery": opts.delivery ?? `d-${delivery}`,
				...(signature === null ? {} : { "x-hub-signature-256": signature }),
			},
			body,
		}),
	);
};

const claim = (caller = "working") =>
	exports.default.fetch(
		new Request(EVENTS, {
			method: "POST",
			headers: { "x-yunomi-dev-caller": caller },
		}),
	);

const failedRun = (conclusion = "failure") => ({
	action: "completed",
	workflow_run: {
		conclusion,
		name: "ci",
		head_branch: "dev/x",
		html_url: "https://github.com/o/r/actions/runs/1",
		pull_requests: [{ number: 12 }],
		triggering_actor: { login: "someone" },
	},
	repository: { full_name: "o/r" },
});

const review = {
	action: "submitted",
	review: {
		state: "changes_requested",
		body: "ここを直して",
		html_url: "https://github.com/o/r/pull/3#pullrequestreview-1",
		user: { login: "reviewer", type: "User" },
	},
	pull_request: { number: 3, title: "直す" },
	repository: { full_name: "o/r" },
};

describe("verifySignature", () => {
	const body = new TextEncoder().encode('{"a":1}').buffer as ArrayBuffer;

	it("同じ secret の署名だけを通す", async () => {
		expect(
			await verifySignature(SECRET, body, await sign(SECRET, '{"a":1}')),
		).toBe(true);
		expect(
			await verifySignature(SECRET, body, await sign("other", '{"a":1}')),
		).toBe(false);
		expect(await verifySignature(SECRET, body, null)).toBe(false);
		expect(await verifySignature(SECRET, body, "sha256=zz")).toBe(false);
		expect(await verifySignature(SECRET, body, "sha1=abc")).toBe(false);
	});
});

describe("toWorkEvent", () => {
	it("Actions の check_suite は workflow_run と重なるので捨てる", () => {
		const suite = (slug: string) => ({
			action: "completed",
			check_suite: {
				conclusion: "failure",
				head_branch: "main",
				head_sha: "abc",
				app: { slug, name: slug },
				pull_requests: [],
			},
			repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
			sender: { login: "x" },
		});
		expect(toWorkEvent("check_suite", suite("github-actions"))).toBeNull();
		expect(toWorkEvent("check_suite", suite("other-ci"))).toMatchObject({
			kind: "ci_failed",
			url: "https://github.com/o/r/commit/abc/checks",
		});
	});

	it("成功した run、編集されたコメントは席を動かさない", () => {
		expect(toWorkEvent("workflow_run", failedRun("success"))).toBeNull();
		expect(
			toWorkEvent("issue_comment", {
				action: "edited",
				comment: { body: "x", html_url: "u", user: { login: "a" } },
				issue: { number: 1, title: "t" },
				repository: { full_name: "o/r" },
			}),
		).toBeNull();
		expect(toWorkEvent("push", {})).toBeNull();
	});

	it("issue_comment は PR のコメントかどうかと bot かどうかを持つ", () => {
		expect(
			toWorkEvent("issue_comment", {
				action: "created",
				comment: {
					body: "b",
					html_url: "u",
					user: { login: "renovate[bot]", type: "Bot" },
				},
				issue: { number: 4, title: "t", pull_request: {} },
				repository: { full_name: "o/r" },
			}),
		).toEqual({
			kind: "comment",
			repo: "o/r",
			number: 4,
			is_pr: true,
			title: "t",
			body: "b",
			url: "u",
			actor: "renovate[bot]",
			actor_is_bot: true,
		});
	});
});

describe("GitHub の webhook", () => {
	it("署名なし・違う署名は 401 で捨て、Working に渡らない", async () => {
		await claim();
		expect(
			(await deliver("workflow_run", failedRun(), { signature: null })).status,
		).toBe(401);
		const wrong = await sign("not-the-secret", JSON.stringify(failedRun()));
		expect(
			(await deliver("workflow_run", failedRun(), { signature: wrong })).status,
		).toBe(401);
		const res = await claim();
		expect(await res.json()).toEqual({ events: [] });
	});

	it("署名の合う出来事を置き、Working が一度だけ取り出せる", async () => {
		await claim();
		expect((await deliver("workflow_run", failedRun())).status).toBe(202);
		expect((await deliver("pull_request_review", review)).status).toBe(202);
		expect((await deliver("ping", { zen: "x" })).status).toBe(204);

		const first = (await (await claim()).json()) as {
			events: { event: { kind: string } }[];
		};
		expect(first.events.map((e) => e.event.kind)).toEqual([
			"ci_failed",
			"review",
		]);
		expect(await (await claim()).json()).toEqual({ events: [] });
	});

	it("同じ delivery の再送は一つにまとめる", async () => {
		await claim();
		await deliver("pull_request_review", review, { delivery: "same" });
		await deliver("pull_request_review", review, { delivery: "same" });
		const body = (await (await claim()).json()) as { events: unknown[] };
		expect(body.events).toHaveLength(1);
	});

	it("取り出せるのは working の service token だけ", async () => {
		expect((await claim("gateway")).status).toBe(403);
		expect(
			(await exports.default.fetch(new Request(EVENTS, { method: "POST" })))
				.status,
		).toBe(401);
	});
});
