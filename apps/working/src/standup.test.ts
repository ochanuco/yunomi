import { err, externalServiceUnavailable, ok } from "@yunomi/core";
import type { DiscordMessageCreatedEnvelope } from "@yunomi/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeRunner, ExecResult } from "./claude-cli.ts";
import type { ChannelInfo, DiscordApi } from "./discord-rest.ts";
import { createIntake } from "./intake.ts";
import { silentLogger } from "./logger.ts";
import { openMacStateStore } from "./mac-state.ts";
import { parseDecisions, runStandup } from "./standup.ts";
import {
	gatherStandupMaterials,
	type StandupMaterials,
} from "./standup-materials.ts";
import {
	memoryApprovals,
	memorySessions,
	tempDir,
	tempLedger,
} from "./test-support.ts";

const FORUM = "forum";
const NOW = new Date("2026-11-05T00:00:00Z");

const fakeDiscord = () => {
	const channels = new Map<string, ChannelInfo>([
		[
			FORUM,
			{
				id: FORUM,
				name: "仕事",
				parentId: "cat",
				appliedTagIds: [],
				availableTags: [
					{ id: "tag-decide", name: "決めてほしい" },
					{ id: "tag-working", name: "作業中" },
					{ id: "tag-done", name: "完了" },
				],
			},
		],
	]);
	const posts: { name: string; content: string; tagIds: string[] }[] = [];
	const sent: { channelId: string; content: string }[] = [];
	let n = 0;
	const api: DiscordApi = {
		me: async () => ok({ id: "bot" }),
		getChannel: async (id) => {
			const ch = channels.get(id);
			return ch
				? ok(ch)
				: err(externalServiceUnavailable({ service: "discord" }));
		},
		getMessage: async (_c, id) =>
			ok({ id, authorId: "u", authorName: "U", isBot: false, content: "" }),
		listMessages: async () => ok([]),
		createForumPost: vi.fn(async (_forum, post) => {
			n++;
			const threadId = `post${n}`;
			posts.push(post);
			channels.set(threadId, {
				id: threadId,
				name: post.name,
				parentId: FORUM,
				appliedTagIds: post.tagIds,
				availableTags: [],
			});
			return ok({ threadId });
		}),
		send: async (channelId, content) => {
			sent.push({ channelId, content });
			return ok({ messageIds: [`m${sent.length}`] });
		},
		setTags: async (id, tagIds) => {
			const ch = channels.get(id);
			if (ch) ch.appliedTagIds = tagIds;
			return ok(undefined);
		},
	};
	return { api, posts, sent };
};

const materials = (
	over: Partial<StandupMaterials["claude_login"]> = {},
): StandupMaterials => ({
	memory: { facts: [] },
	mac_state: { unavailable: "x" },
	github: {
		open_prs: [],
		failing_prs: [],
		handoffs: [],
		working_prs: [],
	},
	claude_login: {
		expires_at: new Date("2026-12-01T00:00:00Z"),
		expires_soon: false,
		...over,
	},
});

const decisionsReply = (n: number) =>
	`朝会のメモ\n\n\`\`\`json\n${JSON.stringify({
		decisions: Array.from({ length: n }, (_, i) => ({
			title: `件${i + 1}`,
			body: `本文${i + 1}`,
		})),
	})}\n\`\`\``;

const fakeClaude = (text: string) => {
	const run = vi.fn<ClaudeRunner["run"]>(async ({ session }) =>
		ok({
			sessionId: session.kind === "fork" ? "forked" : session.id,
			text,
		}),
	);
	return { run, summarize: vi.fn(async () => ok("x")) } as ClaudeRunner & {
		run: typeof run;
	};
};

const setup = (text: string, m = materials()) => {
	const discord = fakeDiscord();
	const claude = fakeClaude(text);
	const sessions = memorySessions();
	const approvals = memoryApprovals();
	const ledger = tempLedger();
	const deps = {
		claude,
		discord: discord.api,
		sessions,
		approvals,
		ledger,
		workForumChannelId: FORUM,
		gather: async () => m,
		newSessionId: () => "standup-session",
		now: () => NOW,
		logger: silentLogger,
	};
	return { deps, discord, claude, sessions, approvals, ledger };
};

describe("runStandup", () => {
	it("決めてほしいことが 0 件なら何も投稿しない", async () => {
		const t = setup(decisionsReply(0));
		const r = await runStandup(t.deps);
		expect(r.decisions).toBe(0);
		expect(t.discord.api.createForumPost).not.toHaveBeenCalled();
		expect(t.discord.sent).toEqual([]);
	});

	it("N 件なら N 投稿を立て、タグを付け、朝会のセッションに紐づける", async () => {
		const t = setup(decisionsReply(3));
		const r = await runStandup(t.deps);
		expect(r.posted).toEqual(["post1", "post2", "post3"]);
		expect(t.discord.posts.map((p) => p.name)).toEqual(["件1", "件2", "件3"]);
		expect(t.discord.posts.every((p) => p.tagIds[0] === "tag-decide")).toBe(
			true,
		);
		expect(t.discord.posts[0]?.content).toContain("本文1");
		expect(t.discord.posts[0]?.content).toContain("2026-11-05 の朝会");
		for (const id of r.posted) {
			expect(t.sessions.get(id)).toBe("standup-session");
			expect(t.sessions.isFork(id)).toBe(true);
		}
	});

	it("材料は JST の書式で渡し、ISO の時刻を prompt に入れない", async () => {
		const t = setup(decisionsReply(0));
		await runStandup(t.deps);
		const prompt = t.claude.run.mock.calls[0]?.[0].prompt ?? "";
		expect(prompt).toContain("2026-12-01 09:00 JST");
		expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
	});

	it("ログインの期限が近ければ、Claude が 0 件でも 1 件立てる", async () => {
		const t = setup(
			decisionsReply(0),
			materials({
				expires_at: new Date("2026-11-08T00:00:00Z"),
				expires_soon: true,
			}),
		);
		const r = await runStandup(t.deps);
		expect(r.posted).toHaveLength(1);
		expect(t.discord.posts[0]?.name).toContain("ログイン");
		expect(t.discord.posts[0]?.content).toContain("2026-11-08 09:00 JST");
	});

	it("読めない返事なら投稿しない", async () => {
		const t = setup("決めてほしいことはありません");
		const r = await runStandup(t.deps);
		expect(r.posted).toEqual([]);
	});

	it("hook が止めた操作は 1 投稿にまとめ、許可を待つ", async () => {
		const t = setup(decisionsReply(0));
		t.deps.claude.run.mockImplementationOnce(async ({ guard, session }) => {
			t.ledger.addPending(guard.threadId, {
				operation: { tool: "Bash", target: "gh pr merge 3" },
				reason: "gh pr merge",
			});
			return ok({ sessionId: session.id, text: decisionsReply(0) });
		});
		const r = await runStandup(t.deps);
		expect(r.posted).toEqual(["post1"]);
		expect(t.discord.posts[0]?.content).toContain("gh pr merge 3");
		expect(t.approvals.get("post1")?.operations).toEqual([
			{ tool: "Bash", target: "gh pr merge 3" },
		]);
	});

	it("朝会の投稿への返事は、朝会のセッションを fork して続ける", async () => {
		const t = setup(decisionsReply(2));
		await runStandup(t.deps);
		const intake = createIntake({
			discord: t.discord.api,
			claude: t.claude,
			sessions: t.sessions,
			approvals: t.approvals,
			ledger: t.ledger,
			botUserId: "bot",
			ownerUserIds: new Set(["owner"]),
			workTextChannelId: "text",
			workForumChannelId: FORUM,
			newSessionId: () => "new",
			logger: silentLogger,
		});
		t.claude.run.mockClear();
		await intake.handle({
			event_id: "e",
			payload: {
				guild_id: "g",
				channel_id: "post2",
				message_id: "r1",
				author: { id: "owner", display_name: "持ち主", is_bot: false },
				content: "B でお願い",
				mentions: [],
				reply_to_message_id: null,
				attachments: [],
			},
		} as unknown as DiscordMessageCreatedEnvelope);
		const call = t.claude.run.mock.calls[0]?.[0];
		expect(call?.session).toEqual({ kind: "fork", id: "standup-session" });
		expect(call?.prompt).toContain("「件2」");
		expect(call?.prompt).toContain("B でお願い");
		// 2 回目からは fork 先を resume する
		expect(t.sessions.get("post2")).toBe("forked");
		expect(t.sessions.isFork("post2")).toBe(false);
		expect(t.sessions.isFork("post1")).toBe(true);
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
});
