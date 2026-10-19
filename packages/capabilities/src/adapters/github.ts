import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
	rateLimited,
	validationFailed,
} from "@yunomi/core";
import * as v from "valibot";
import type { CapabilityAdapter, CapabilityResponse } from "../contract.ts";
import { type GithubReadInput, githubRead } from "../definitions/github.ts";
import { parseToolInput } from "../input.ts";

const SERVICE = "github";
const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_BODY_CHARS = 1_500;
const DEFAULT_TIMEOUT_MS = 10_000;

export type GithubDeps = {
	fetch: typeof fetch;
	token: string;
	/** repo を省略した呼び出しが読む `owner/name`。 */
	defaultRepo?: string;
	/** GitHub API への fetch の待ち時間の上限（ms）。既定は 10 秒。 */
	timeoutMs?: number;
};

const IssueResponse = v.object({
	number: v.number(),
	title: v.string(),
	state: v.string(),
	labels: v.optional(
		v.array(v.union([v.string(), v.object({ name: v.optional(v.string()) })])),
		[],
	),
	user: v.optional(v.nullable(v.object({ login: v.string() }))),
	created_at: v.string(),
	updated_at: v.string(),
	body: v.optional(v.nullable(v.string())),
	comments: v.optional(v.number(), 0),
	html_url: v.string(),
	pull_request: v.optional(
		v.object({ merged_at: v.optional(v.nullable(v.string())) }),
	),
});

// externalServiceUnavailable は retryable: true で作られる。直らない失敗は retryable を下げる。
const unavailable = (detail: string, retryable = true): DomainError => {
	const base = externalServiceUnavailable({ service: SERVICE });
	return { ...base, retryable, message: `${base.message}: ${detail}` };
};

const truncate = (body: string): { text: string; truncated: boolean } => {
	const chars = Array.from(body);
	return chars.length <= MAX_BODY_CHARS
		? { text: body, truncated: false }
		: { text: chars.slice(0, MAX_BODY_CHARS).join(""), truncated: true };
};

/**
 * GitHub REST API の Issue / PR の adapter。読み取りだけで、状態を持たない。
 * summary には対象の位置と種類だけを書き、タイトルと本文は入れない（private repo の中身を Audit に残さない）。
 */
export const createGithubAdapter = (deps: GithubDeps): CapabilityAdapter => {
	// Workers の fetch は this が globalThis でないと Illegal invocation になるため、プロパティ越しに呼ばない。
	const doFetch = deps.fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const apiFailure = (res: Response): DomainError => {
		// 一次制限は 403 + x-ratelimit-remaining: 0、二次制限は 429 で来る。
		if (
			res.status === 429 ||
			(res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
		) {
			return rateLimited({ retryAfterMs: null });
		}
		// 404 は存在しないか、token に権限がない（GitHub は権限のない private repo の存在を隠す）。
		const detail =
			res.status === 404
				? "Issue / PR が見つからない（存在しないか、権限がない） (404)"
				: `GitHub API が ${res.status} を返した`;
		return unavailable(detail, res.status >= 500);
	};

	const read = async (
		input: GithubReadInput,
	): Promise<Result<CapabilityResponse, DomainError>> => {
		const repo = input.repo ?? deps.defaultRepo;
		if (!repo) {
			return err(
				validationFailed({
					issues: ["repo: 省略できる既定の repo が設定されていない"],
				}),
			);
		}
		const [owner = "", name = ""] = repo.split("/");
		const url = `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${input.number}`;

		let res: Response;
		try {
			res = await doFetch(url, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${deps.token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": API_VERSION,
					"User-Agent": "yunomi",
				},
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (e) {
			const timedOut = e instanceof Error && e.name === "TimeoutError";
			return err(
				unavailable(
					timedOut
						? "GitHub API の応答がタイムアウトした"
						: "GitHub API に接続できない",
				),
			);
		}
		if (!res.ok) return err(apiFailure(res));
		const parsed = v.safeParse(
			IssueResponse,
			await res.json().catch(() => null),
		);
		if (!parsed.success) {
			const issue = parsed.issues[0];
			const path = issue === undefined ? null : v.getDotPath(issue);
			return err(
				unavailable(`GitHub API の応答が想定と違う (${path ?? "応答全体"})`),
			);
		}

		const issue = parsed.output;
		const isPr = issue.pull_request !== undefined;
		const state = issue.pull_request?.merged_at ? "merged" : issue.state;
		const body = truncate(issue.body ?? "");
		return ok({
			data: {
				kind: isPr ? "pull_request" : "issue",
				repo,
				number: issue.number,
				title: issue.title,
				state,
				labels: issue.labels.flatMap((l) => {
					const label = typeof l === "string" ? l : l.name;
					return label === undefined ? [] : [label];
				}),
				author: issue.user?.login ?? null,
				created_at: new Date(issue.created_at),
				updated_at: new Date(issue.updated_at),
				body: body.text,
				body_truncated: body.truncated,
				comments: issue.comments,
				url: issue.html_url,
			},
			summary: `${repo}#${input.number} (${isPr ? "pull_request" : "issue"}) を取得`,
		});
	};

	return {
		tools: [githubRead],
		async execute(request) {
			if (request.tool !== githubRead.name) {
				return err(
					validationFailed({ issues: [`未知の道具: ${request.tool}`] }),
				);
			}
			const input = parseToolInput(githubRead, request.input);
			return input.ok ? read(input.value) : input;
		},
	};
};
