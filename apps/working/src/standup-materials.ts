import * as v from "valibot";
import type { Exec } from "./exec.ts";
import type { Logger } from "./logger.ts";
import type { MacStateStore } from "./mac-state.ts";

/** 7 日以内に切れるなら、持ち主にログインし直してもらう。 */
export const LOGIN_EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000;
const REPO_LIMIT = 20;

type Unavailable = { unavailable: string };

export type StandupMaterials = {
	memory: unknown;
	mac_state:
		| {
				received_at: Date;
				worktrees: unknown[];
		  }
		| Unavailable;
	github: {
		open_prs: unknown[] | Unavailable;
		failing_prs: unknown[] | Unavailable;
		handoffs: unknown[] | Unavailable;
		working_prs: unknown[] | Unavailable;
	};
	claude_login: { expires_at: Date | null; expires_soon: boolean };
};

export type MaterialDeps = {
	exec: Exec;
	env: Record<string, string>;
	cwd: string;
	claudeBin: string;
	memoryBin: string;
	githubOwner: string;
	macState: MacStateStore;
	now: () => Date;
	logger: Logger;
};

const searchPrSchema = v.array(
	v.object({
		repository: v.object({ nameWithOwner: v.string() }),
		number: v.number(),
		title: v.string(),
		url: v.string(),
		isDraft: v.optional(v.boolean()),
		updatedAt: v.optional(v.string()),
		author: v.optional(v.object({ login: v.string() })),
	}),
);
const searchIssueSchema = v.array(
	v.object({
		repository: v.object({ nameWithOwner: v.string() }),
		number: v.number(),
		title: v.string(),
		url: v.string(),
		labels: v.optional(v.array(v.object({ name: v.string() }))),
	}),
);
const repoPrSchema = v.array(
	v.object({
		number: v.number(),
		title: v.string(),
		url: v.string(),
		headRefName: v.string(),
		isDraft: v.optional(v.boolean()),
	}),
);
const authSchema = v.object({
	loggedIn: v.optional(v.boolean()),
	loginExpiresAt: v.nullish(v.string()),
});

const toDate = (iso: string | undefined | null): Date | null => {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? null : new Date(t);
};

const msToDate = (ms: number | null | undefined) =>
	ms === null || ms === undefined ? null : new Date(ms);

/**
 * 朝会に渡す材料を集める。どれかが取れなくても朝会は回し、取れなかったことを材料に書く。
 * 時刻は Date にして返し、prompt にするときに toModelJson で JST の書式にする。
 */
export const gatherStandupMaterials = async (
	deps: MaterialDeps,
): Promise<StandupMaterials> => {
	const run = async <T>(
		label: string,
		bin: string,
		args: readonly string[],
		schema: v.GenericSchema<unknown, T>,
	): Promise<T | Unavailable> => {
		const out = await deps.exec(bin, args, {
			stdin: "",
			cwd: deps.cwd,
			timeoutMs: 60_000,
			env: deps.env,
		});
		if (out.code !== 0) {
			deps.logger.warn("standup material failed", {
				label,
				code: out.code,
				stderr: out.stderr.slice(0, 300),
			});
			return { unavailable: `${label} を取れなかった` };
		}
		let json: unknown;
		try {
			json = JSON.parse(out.stdout);
		} catch {
			json = undefined;
		}
		const parsed = v.safeParse(schema, json);
		if (!parsed.success) {
			deps.logger.warn("standup material unreadable", { label });
			return { unavailable: `${label} を読めなかった` };
		}
		return parsed.output;
	};
	const failed = (x: unknown): x is Unavailable =>
		typeof x === "object" && x !== null && "unavailable" in x;

	const owner = deps.githubOwner;
	const prFields = "repository,number,title,url,isDraft,updatedAt,author";
	const [memory, latest, openPrs, failingPrs, handoffs, auth] =
		await Promise.all([
			run("記憶", deps.memoryBin, ["read"], v.unknown()),
			deps.macState.latest(),
			run(
				"open な PR",
				"gh",
				[
					"search",
					"prs",
					"--owner",
					owner,
					"--state",
					"open",
					"--json",
					prFields,
					"--limit",
					"100",
				],
				searchPrSchema,
			),
			run(
				"CI が落ちている PR",
				"gh",
				[
					"search",
					"prs",
					"--owner",
					owner,
					"--state",
					"open",
					"--checks",
					"failure",
					"--json",
					prFields,
					"--limit",
					"50",
				],
				searchPrSchema,
			),
			run(
				"申し送り",
				"gh",
				[
					"search",
					"issues",
					"--owner",
					owner,
					"--label",
					"working-handoff",
					"--state",
					"open",
					"--json",
					"repository,number,title,url,labels",
					"--limit",
					"50",
				],
				searchIssueSchema,
			),
			run(
				"Claude CLI のログイン",
				deps.claudeBin,
				["auth", "status", "--json"],
				authSchema,
			),
		]);

	const pr = (p: v.InferOutput<typeof searchPrSchema>[number]) => ({
		repo: p.repository.nameWithOwner,
		number: p.number,
		title: p.title,
		url: p.url,
		draft: p.isDraft ?? false,
		author: p.author?.login ?? null,
		updated_at: toDate(p.updatedAt),
	});

	// Working が出す PR は GH_TOKEN の人が dev/ ブランチから出したもの。search は head を返さないので、repo ごとに引く
	let workingPrs: unknown[] | Unavailable;
	if (failed(openPrs)) {
		workingPrs = openPrs;
	} else {
		const repos = [
			...new Set(openPrs.map((p) => p.repository.nameWithOwner)),
		].slice(0, REPO_LIMIT);
		const perRepo = await Promise.all(
			repos.map(async (repo) => {
				const r = await run(
					`${repo} の PR`,
					"gh",
					[
						"pr",
						"list",
						"--repo",
						repo,
						"--state",
						"open",
						"--author",
						"@me",
						"--json",
						"number,title,url,headRefName,isDraft",
						"--limit",
						"50",
					],
					repoPrSchema,
				);
				return failed(r)
					? []
					: r
							.filter((p) => p.headRefName.startsWith("dev/"))
							.map((p) => ({
								repo,
								number: p.number,
								title: p.title,
								url: p.url,
								branch: p.headRefName,
								draft: p.isDraft ?? false,
							}));
			}),
		);
		workingPrs = perRepo.flat();
	}

	const expiresAt = failed(auth) ? null : toDate(auth.loginExpiresAt);
	return {
		memory,
		mac_state:
			latest === null
				? { unavailable: "Mac から席の状態が届いたことがない" }
				: {
						received_at: latest.receivedAt,
						worktrees: latest.state.worktrees.map((w) => ({
							...w,
							last_activity_at: msToDate(w.last_activity_at),
							agents: w.agents.map((a) => ({
								...a,
								updated_at: msToDate(a.updated_at),
							})),
						})),
					},
		github: {
			open_prs: failed(openPrs) ? openPrs : openPrs.map(pr),
			failing_prs: failed(failingPrs) ? failingPrs : failingPrs.map(pr),
			handoffs: failed(handoffs)
				? handoffs
				: handoffs.map((i) => ({
						repo: i.repository.nameWithOwner,
						number: i.number,
						title: i.title,
						url: i.url,
						picked: (i.labels ?? []).some(
							(l) => l.name === "working-handoff-picked",
						),
					})),
			working_prs: workingPrs,
		},
		claude_login: {
			expires_at: expiresAt,
			expires_soon:
				expiresAt !== null &&
				expiresAt.getTime() - deps.now().getTime() <= LOGIN_EXPIRY_WARN_MS,
		},
	};
};
