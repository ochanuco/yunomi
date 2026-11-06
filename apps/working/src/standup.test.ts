import { describe, expect, it, vi } from "vitest";
import type { ExecResult } from "./exec.ts";
import { silentLogger } from "./logger.ts";
import { openMacStateStore } from "./mac-state.ts";
import type { PatrolSnapshot, PatrolStore } from "./patrol.ts";
import { finishStandup, parseDecisions, startStandup } from "./standup.ts";
import {
	ciOf,
	gatherStandupMaterials,
	type StandupMaterials,
} from "./standup-materials.ts";
import {
	FORUM,
	fakeDiscord,
	memoryApprovals,
	tempDir,
	tempLedger,
} from "./test-support.ts";

const NOW = new Date("2026-11-05T00:00:00Z");

const materials = (
	over: Partial<StandupMaterials["claude_login"]> = {},
	github: Partial<StandupMaterials["github"]> = {},
): StandupMaterials => ({
	memory: { facts: [] },
	mac_state: { unavailable: "x" },
	github: {
		open_prs: [],
		failing_prs: [],
		handoffs: [],
		working_prs: [],
		renovate_prs: [],
		...github,
	},
	claude_login: {
		expires_at: new Date("2026-12-01T00:00:00Z"),
		expires_soon: false,
		...over,
	},
});

const memoryStore = (initial: PatrolSnapshot | null = null) => {
	const store: PatrolStore & { saved: PatrolSnapshot | null } = {
		saved: initial,
		load: async () => store.saved,
		save: async (s) => {
			store.saved = s;
		},
	};
	return store;
};

const failingPr = (number: number) => ({
	repo: "ochanuco/yunomi",
	number,
	title: `PR ${number}`,
	url: `https://github.com/ochanuco/yunomi/pull/${number}`,
	draft: false,
	author: "ochanuco",
	updated_at: NOW,
});

const decisionsReply = (n: number) =>
	`朝会のメモ\n\n\`\`\`json\n${JSON.stringify({
		decisions: Array.from({ length: n }, (_, i) => ({
			title: `件${i + 1}`,
			body: `本文${i + 1}`,
		})),
	})}\n\`\`\``;

const setup = () => {
	const discord = fakeDiscord();
	const approvals = memoryApprovals();
	const ledger = tempLedger();
	const deps = {
		discord: discord.api,
		approvals,
		ledger,
		workForumChannelId: FORUM,
		now: () => NOW,
		logger: silentLogger,
	};
	return { deps, discord, approvals, ledger };
};

describe("startStandup", () => {
	it("材料を JST の書式にして、前置きを付けた spec で朝会の席を作る", async () => {
		const t = setup();
		const start = vi.fn(async (_spec: string) => "standup-1");
		await startStandup({
			deps: t.deps,
			kind: "standup",
			store: memoryStore(),
			gather: async () => materials(),
			preamble: "【前置き】",
			start,
		});
		const spec = start.mock.calls[0]?.[0] ?? "";
		expect(spec.startsWith("【前置き】")).toBe(true);
		expect(spec).toContain("朝会をする");
		expect(spec).toContain("2026-12-01 09:00 JST");
		expect(spec).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
		expect(t.discord.posts).toEqual([]);
	});

	it("ログインの期限が近ければ、席の返事を待たずに 1 件立てる", async () => {
		const t = setup();
		await startStandup({
			deps: t.deps,
			kind: "standup",
			store: memoryStore(),
			gather: async () =>
				materials({
					expires_at: new Date("2026-11-08T00:00:00Z"),
					expires_soon: true,
				}),
			preamble: "",
			start: async () => "standup-1",
		});
		expect(t.discord.posts[0]?.name).toContain("ログイン");
		expect(t.discord.posts[0]?.content).toContain("2026-11-08 09:00 JST");
	});
});

describe("startStandup の見回り", () => {
	const patrol = (
		store: PatrolStore,
		github: Partial<StandupMaterials["github"]>,
		start = vi.fn(async (_spec: string, _kind: string) => "patrol-1"),
	) =>
		startStandup({
			deps: setup().deps,
			kind: "patrol",
			store,
			gather: async () =>
				materials(
					{ expires_at: new Date("2026-11-06T00:00:00Z"), expires_soon: true },
					github,
				),
			preamble: "",
			start,
		}).then((id) => ({ id, start }));

	it("初めての回は覚えるだけで、席を立てない", async () => {
		const store = memoryStore();
		const r = await patrol(store, { failing_prs: [failingPr(1)] });
		expect(r.id).toBeNull();
		expect(r.start).not.toHaveBeenCalled();
		expect(store.saved?.failing_prs).toEqual({ "ochanuco/yunomi#1": "" });
	});

	it("前の回から変わっていなければ席を立てない", async () => {
		const store = memoryStore();
		await patrol(store, { failing_prs: [failingPr(1)] });
		const r = await patrol(store, { failing_prs: [failingPr(1)] });
		expect(r.start).not.toHaveBeenCalled();
	});

	it("新しく落ちた PR だけを材料にして席を立て、ログインの期限は投稿しない", async () => {
		const store = memoryStore();
		await patrol(store, { failing_prs: [failingPr(1)] });
		const t = setup();
		const start = vi.fn(async (_spec: string, _kind: string) => "patrol-1");
		await startStandup({
			deps: t.deps,
			kind: "patrol",
			store,
			gather: async () =>
				materials(
					{ expires_at: new Date("2026-11-06T00:00:00Z"), expires_soon: true },
					{ failing_prs: [failingPr(1), failingPr(2)] },
				),
			preamble: "",
			start,
		});
		const [spec, kind] = start.mock.calls[0] ?? [];
		expect(kind).toBe("patrol");
		expect(spec).toContain("見回りをする");
		expect(spec).toContain("pull/2");
		expect(spec).not.toContain('pull/1"');
		expect(t.discord.posts).toEqual([]);
		// 同じ件は次の回では拾わない
		const again = await patrol(store, {
			failing_prs: [failingPr(1), failingPr(2)],
		});
		expect(again.start).not.toHaveBeenCalled();
	});

	it("席を立てられなければ覚えず、次の回で拾い直す", async () => {
		const store = memoryStore();
		await patrol(store, {});
		await expect(
			patrol(
				store,
				{ failing_prs: [failingPr(3)] },
				vi.fn(async () => {
					throw new Error("orca down");
				}),
			),
		).rejects.toThrow("orca down");
		const r = await patrol(store, { failing_prs: [failingPr(3)] });
		expect(r.start).toHaveBeenCalledOnce();
	});
});

describe("finishStandup", () => {
	it("決めてほしいことが 0 件なら何も投稿しない", async () => {
		const t = setup();
		const r = await finishStandup(t.deps, decisionsReply(0), []);
		expect(r.posted).toEqual([]);
		expect(t.discord.api.createForumPost).not.toHaveBeenCalled();
	});

	it("N 件なら N 投稿を立ててタグを決めてほしいにする", async () => {
		const t = setup();
		const r = await finishStandup(t.deps, decisionsReply(3), []);
		expect(r.posted).toEqual(["thread1", "thread2", "thread3"]);
		expect(t.discord.posts.map((p) => p.name)).toEqual(["件1", "件2", "件3"]);
		expect(t.discord.posts.every((p) => p.tagIds[0] === "tag-decide")).toBe(
			true,
		);
		expect(t.discord.posts[0]?.content).toContain("本文1");
		expect(t.discord.posts[0]?.content).toContain("2026-11-05 の朝会");
	});

	it("読めない返事なら投稿しない", async () => {
		const t = setup();
		const r = await finishStandup(t.deps, "決めてほしいことはありません", []);
		expect(r.posted).toEqual([]);
	});

	it("hook が止めた操作は 1 投稿にまとめ、許可を待つ", async () => {
		const t = setup();
		const op = { tool: "Bash", target: "gh pr merge 3" };
		const r = await finishStandup(t.deps, decisionsReply(0), [
			{ operation: op, reason: "gh pr merge" },
		]);
		expect(r.posted).toEqual(["thread1"]);
		expect(t.discord.posts[0]?.content).toContain("gh pr merge 3");
		expect(t.approvals.get("thread1")?.operations).toEqual([op]);
	});

	it("見回りの投稿は時刻で、止めた操作の件名も見回りにする", async () => {
		const t = setup();
		await finishStandup(
			t.deps,
			decisionsReply(1),
			[{ operation: { tool: "Bash", target: "gh pr merge 3" }, reason: "x" }],
			"patrol",
		);
		expect(t.discord.posts[0]?.content).toContain("09:00 の見回りから");
		expect(t.discord.posts[1]?.name).toBe("見回りで止めた操作");
	});
});

describe("parseDecisions", () => {
	it("最後の json ブロックを読み、長い件名は切る", () => {
		const text = `\`\`\`json\n{"decisions":[]}\n\`\`\`\n\n\`\`\`json\n{"decisions":[{"title":"${"あ".repeat(70)}","body":"b"}]}\n\`\`\``;
		const d = parseDecisions(text);
		expect(d).toHaveLength(1);
		expect(d?.[0]?.title.length).toBe(61);
	});
	it("形が違えば null", () => {
		expect(parseDecisions('```json\n{"decisions":[{"title":""}]}\n```')).toBe(
			null,
		);
		expect(parseDecisions("なし")).toBe(null);
	});
});

describe("gatherStandupMaterials", () => {
	const exec = (table: Record<string, Partial<ExecResult>>) =>
		vi.fn(async (bin: string, args: readonly string[]) => {
			const key = `${bin} ${args.slice(0, 2).join(" ")}`;
			const hit =
				Object.entries(table).find(([k]) => key.startsWith(k))?.[1] ?? {};
			return { code: 0, stdout: "[]", stderr: "", ...hit };
		});

	it("記憶・席の状態・GitHub・ログインの期限を集め、取れなかったものは印を付ける", async () => {
		const dir = tempDir();
		const store = openMacStateStore(dir);
		await store.save(
			{
				sent_at: 1,
				worktrees: [
					{
						repo: "yunomi",
						last_activity_at: Date.parse("2026-11-04T12:00:00Z"),
						agents: [{ type: "claude", state: "done", updated_at: null }],
					},
				],
			},
			new Date("2026-11-04T13:00:00Z"),
		);
		const pr = {
			repository: { nameWithOwner: "o/a" },
			number: 1,
			title: "t",
			url: "u",
			updatedAt: "2026-11-04T00:00:00Z",
		};
		const run = exec({
			"yunomi-memory read": { stdout: '{"facts":[]}' },
			"gh search prs": { stdout: JSON.stringify([pr]) },
			"gh search issues": { code: 1, stderr: "boom" },
			"gh pr list": {
				stdout: JSON.stringify([
					{ number: 1, title: "t", url: "u", headRefName: "dev/x" },
					{ number: 2, title: "t", url: "u", headRefName: "feature" },
				]),
			},
			"claude auth status": {
				stdout: JSON.stringify({ loginExpiresAt: "2026-11-10T00:00:00.000Z" }),
			},
		});
		const m = await gatherStandupMaterials({
			exec: run,
			env: {},
			cwd: "/w",
			claudeBin: "claude",
			memoryBin: "yunomi-memory",
			githubOwner: "o",
			macState: store,
			now: () => NOW,
			logger: silentLogger,
		});
		expect(m.memory).toEqual({ facts: [] });
		expect(m.mac_state).toMatchObject({
			received_at: new Date("2026-11-04T13:00:00Z"),
		});
		expect(m.github.handoffs).toEqual({
			unavailable: "申し送り を取れなかった",
		});
		expect(m.github.working_prs).toEqual([
			expect.objectContaining({ number: 1, branch: "dev/x" }),
		]);
		expect(m.claude_login).toEqual({
			expires_at: new Date("2026-11-10T00:00:00.000Z"),
			expires_soon: true,
		});
	});

	it("Renovate の PR は repo ごとに CI とコンフリクトの状態を引く", async () => {
		const run = vi.fn(async (bin: string, args: readonly string[]) => {
			const line = `${bin} ${args.join(" ")}`;
			if (line.startsWith("gh search prs"))
				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify([
						{
							repository: { nameWithOwner: "o/a" },
							number: 5,
							title: "Update tooling",
							url: "u5",
							author: { login: "renovate[bot]" },
						},
					]),
				};
			if (line.includes("--author app/renovate"))
				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify([
						{
							number: 5,
							title: "Update tooling",
							url: "u5",
							headRefName: "renovate/tooling-non-major",
							mergeable: "CONFLICTING",
							mergeStateStatus: "DIRTY",
							statusCheckRollup: [
								{ status: "COMPLETED", conclusion: "SUCCESS" },
								{ state: "SUCCESS" },
							],
						},
						{
							number: 1,
							title: "Configure Renovate",
							url: "u1",
							headRefName: "renovate/configure",
						},
					]),
				};
			return { code: 0, stdout: "[]", stderr: "" };
		});
		const m = await gatherStandupMaterials({
			exec: run,
			env: {},
			cwd: "/w",
			claudeBin: "claude",
			memoryBin: "yunomi-memory",
			githubOwner: "o",
			macState: openMacStateStore(tempDir()),
			now: () => NOW,
			logger: silentLogger,
		});
		expect(m.github.renovate_prs).toEqual([
			expect.objectContaining({
				repo: "o/a",
				number: 5,
				ci: "success",
				mergeable: "CONFLICTING",
				merge_state: "DIRTY",
				onboarding: false,
			}),
			expect.objectContaining({ number: 1, onboarding: true }),
		]);
	});
});

describe("ciOf", () => {
	it.each([
		[
			"全部通れば success",
			[
				{ status: "COMPLETED", conclusion: "SUCCESS" },
				{ status: "COMPLETED", conclusion: "SKIPPED" },
			],
			"success",
		],
		[
			"1 つでも落ちれば failure",
			[
				{ status: "IN_PROGRESS", conclusion: null },
				{ status: "COMPLETED", conclusion: "FAILURE" },
			],
			"failure",
		],
		[
			"走っているものがあれば pending",
			[{ status: "IN_PROGRESS", conclusion: null }, { state: "SUCCESS" }],
			"pending",
		],
		["StatusContext の失敗も見る", [{ state: "ERROR" }], "failure"],
	])("%s", (_name, rollup, want) => {
		expect(ciOf(rollup)).toBe(want);
	});
});
