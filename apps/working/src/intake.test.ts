import { err, externalServiceUnavailable, ok } from "@yunomi/core";
import type { DiscordMessageCreatedEnvelope } from "@yunomi/protocol";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeRunner } from "./claude-cli.ts";
import type { ChannelInfo, DiscordApi, PostedMessage } from "./discord-rest.ts";
import { createIntake } from "./intake.ts";
import { silentLogger } from "./logger.ts";
import type { SessionStore } from "./session-store.ts";

const BOT = "bot";
const TEXT = "text";
const FORUM = "forum";
const TAGS = [
	{ id: "tag-decide", name: "決めてほしい" },
	{ id: "tag-working", name: "作業中" },
	{ id: "tag-handoff", name: "引き継ぎ" },
	{ id: "tag-done", name: "完了" },
	{ id: "tag-other", name: "その他" },
];

const fakeDiscord = () => {
	const channels = new Map<string, ChannelInfo>([
		[
			FORUM,
			{
				id: FORUM,
				name: "仕事",
				parentId: "cat",
				appliedTagIds: [],
				availableTags: TAGS,
			},
		],
		[
			TEXT,
			{
				id: TEXT,
				name: "仕事",
				parentId: "cat",
				appliedTagIds: [],
				availableTags: [],
			},
		],
	]);
	const messages = new Map<string, PostedMessage>();
	const sent: { channelId: string; content: string; replyTo?: string }[] = [];
	const history = new Map<string, PostedMessage[]>();
	let nextThread = 1;
	const api: DiscordApi = {
		me: async () => ok({ id: BOT }),
		getChannel: vi.fn(async (id: string) => {
			const ch = channels.get(id);
			return ch
				? ok(ch)
				: err(externalServiceUnavailable({ service: "discord" }));
		}),
		getMessage: async (_c, id) => {
			const m = messages.get(id);
			return m
				? ok(m)
				: err(externalServiceUnavailable({ service: "discord" }));
		},
		listMessages: vi.fn(async (channelId: string) =>
			ok(history.get(channelId) ?? []),
		),
		createForumPost: vi.fn(
			async (
				forumId: string,
				post: { name: string; content: string; tagIds: string[] },
			) => {
				const id = `thread${nextThread++}`;
				channels.set(id, {
					id,
					name: post.name,
					parentId: forumId,
					appliedTagIds: post.tagIds,
					availableTags: [],
				});
				return ok({ threadId: id });
			},
		),
		send: async (channelId, content, replyTo) => {
			sent.push({ channelId, content, ...(replyTo ? { replyTo } : {}) });
			return ok(undefined);
		},
		setTags: async (threadId, tagIds) => {
			const ch = channels.get(threadId);
			if (ch) channels.set(threadId, { ...ch, appliedTagIds: tagIds });
			return ok(undefined);
		},
	};
	return { api, channels, messages, sent, history };
};

const memoryStore = (): SessionStore => {
	const m = new Map<string, string>();
	return {
		get: (id) => m.get(id) ?? null,
		set: async (id, s) => {
			m.set(id, s);
		},
	};
};

const fakeClaude = (
	reply: (prompt: string) => string = () => "了解です\n状態: 完了",
) => {
	const known = new Set<string>();
	const run = vi.fn<ClaudeRunner["run"]>(async ({ prompt, session }) => {
		if (session.kind === "resume" && !known.has(session.id)) {
			return {
				ok: false,
				error: { type: "SessionNotFound", sessionId: session.id },
			};
		}
		known.add(session.id);
		return ok({ sessionId: session.id, text: reply(prompt) });
	});
	const summarize = vi.fn<ClaudeRunner["summarize"]>(async () =>
		ok("請求書の整理"),
	);
	return { runner: { run, summarize }, known };
};

const envelope = (
	payload: Partial<DiscordMessageCreatedEnvelope["payload"]>,
): DiscordMessageCreatedEnvelope =>
	({
		event_id: "e",
		payload: {
			guild_id: "g",
			channel_id: TEXT,
			message_id: "m1",
			author: { id: "u1", display_name: "ちゃぬ", is_bot: false },
			content: "<@123> 請求書を整理して",
			mentions: [BOT],
			reply_to_message_id: null,
			attachments: [],
			...payload,
		},
	}) as DiscordMessageCreatedEnvelope;

const setup = (reply?: (prompt: string) => string) => {
	const d = fakeDiscord();
	const c = fakeClaude(reply);
	const sessions = memoryStore();
	let n = 0;
	const deps = {
		discord: d.api,
		claude: c.runner,
		sessions,
		botUserId: BOT,
		ownerUserIds: new Set(["u1"]),
		workTextChannelId: TEXT,
		workForumChannelId: FORUM,
		newSessionId: () => `s${++n}`,
		now: () => new Date("2026-11-05T08:00:00Z"),
		logger: silentLogger,
	};
	return { d, c, sessions, deps, intake: createIntake(deps) };
};

describe("仕事テキストチャンネルの依頼", () => {
	it("Yukarin 宛てなら投稿を立て、リンクを返し、投稿で作業して結果とタグを付ける", async () => {
		const { d, c, sessions, intake } = setup();
		await intake.handle(envelope({}));

		expect(d.api.createForumPost).toHaveBeenCalledWith(FORUM, {
			name: "請求書の整理",
			content: expect.stringContaining(
				"https://discord.com/channels/g/text/m1",
			),
			tagIds: ["tag-working"],
		});
		expect(d.sent[0]).toEqual({
			channelId: TEXT,
			content: expect.stringContaining(
				"https://discord.com/channels/g/thread1",
			),
			replyTo: "m1",
		});
		const call = c.runner.run.mock.calls[0]?.[0];
		expect(call?.session).toEqual({ kind: "new", id: "s1" });
		expect(call?.prompt).toContain("2026-11-05 17:00 JST");
		expect(call?.prompt).toContain("請求書を整理して");
		expect(d.sent[1]).toEqual({ channelId: "thread1", content: "了解です" });
		expect(d.channels.get("thread1")?.appliedTagIds).toEqual(["tag-done"]);
		expect(sessions.get("thread1")).toBe("s1");
	});

	it("Yukarin への返信も依頼として受ける", async () => {
		const { d, intake } = setup();
		d.messages.set("prev", {
			id: "prev",
			authorId: BOT,
			authorName: "ゆかり",
			isBot: true,
			content: "?",
		});
		await intake.handle(
			envelope({ mentions: [], reply_to_message_id: "prev" }),
		);
		expect(d.api.createForumPost).toHaveBeenCalledTimes(1);
	});

	it("宛てていない発言・人への返信・自分の発言は無視する", async () => {
		const { d, c, intake } = setup();
		d.messages.set("p", {
			id: "p",
			authorId: "u2",
			authorName: "x",
			isBot: false,
			content: "",
		});
		await intake.handle(envelope({ mentions: [] }));
		await intake.handle(envelope({ mentions: [], reply_to_message_id: "p" }));
		await intake.handle(
			envelope({ author: { id: BOT, display_name: "ゆかり", is_bot: true } }),
		);
		expect(d.api.createForumPost).not.toHaveBeenCalled();
		expect(c.runner.run).not.toHaveBeenCalled();
	});

	it("要約に失敗したら依頼の 1 行目を件名にする", async () => {
		const { d, c, intake } = setup();
		c.runner.summarize.mockResolvedValueOnce({
			ok: false,
			error: { type: "ClaudeFailed", reason: "x" },
		});
		await intake.handle(envelope({}));
		expect(d.api.createForumPost).toHaveBeenCalledWith(
			FORUM,
			expect.objectContaining({ name: "請求書を整理して" }),
		);
	});
});

describe("発言者の絞り込み", () => {
	const stranger = { id: "u2", display_name: "よその人", is_bot: false };
	const otherBot = { id: "b2", display_name: "別の bot", is_bot: true };

	it("持ち主以外の人と別の bot の依頼・フォーラムの投稿・投稿内の返事は無視する", async () => {
		const { d, c, sessions, intake } = setup();
		d.channels.set("t1", {
			id: "t1",
			name: "x",
			parentId: FORUM,
			appliedTagIds: [],
			availableTags: [],
		});
		d.channels.set("t2", {
			id: "t2",
			name: "y",
			parentId: FORUM,
			appliedTagIds: [],
			availableTags: [],
		});
		await sessions.set("t2", "s-old");
		for (const author of [stranger, otherBot]) {
			await intake.handle(envelope({ author }));
			await intake.handle(
				envelope({ author, channel_id: "t1", message_id: "t1", mentions: [] }),
			);
			await intake.handle(
				envelope({ author, channel_id: "t2", message_id: "r", mentions: [] }),
			);
		}
		expect(d.api.createForumPost).not.toHaveBeenCalled();
		expect(c.runner.run).not.toHaveBeenCalled();
		expect(c.runner.summarize).not.toHaveBeenCalled();
		expect(d.sent).toEqual([]);
	});
});

describe("仕事フォーラムの投稿", () => {
	const threadOf = (d: ReturnType<typeof fakeDiscord>, id: string) =>
		d.channels.set(id, {
			id,
			name: "直接の相談",
			parentId: FORUM,
			appliedTagIds: ["tag-other"],
			availableTags: [],
		});

	it("人が直接立てた投稿で作業を始める", async () => {
		const { d, c, sessions, intake } = setup(
			() => "どちらにしますか\n状態: 決めてほしい",
		);
		threadOf(d, "t9");
		await intake.handle(
			envelope({
				channel_id: "t9",
				message_id: "t9",
				mentions: [],
				content: "見積もりを比べたい",
			}),
		);
		const call = c.runner.run.mock.calls[0]?.[0];
		expect(call?.session.kind).toBe("new");
		expect(call?.prompt).toContain("件名: 直接の相談");
		expect(call?.prompt).toContain("見積もりを比べたい");
		expect(sessions.get("t9")).toBe("s1");
		expect(d.sent).toEqual([{ channelId: "t9", content: "どちらにしますか" }]);
		expect(d.channels.get("t9")?.appliedTagIds).toEqual([
			"tag-other",
			"tag-decide",
		]);
	});

	it("投稿内の返事は同じセッションに --resume で渡す", async () => {
		const { c, intake } = setup();
		await intake.handle(envelope({}));
		await intake.handle(
			envelope({
				channel_id: "thread1",
				message_id: "r1",
				mentions: [],
				content: "追加でこれも",
			}),
		);
		const second = c.runner.run.mock.calls[1]?.[0];
		expect(second?.session).toEqual({ kind: "resume", id: "s1" });
		expect(second?.prompt).toContain("ちゃぬ: 追加でこれも");
	});

	it("セッションが失われていたら投稿の履歴を読ませて新しいセッションで続ける", async () => {
		const { d, c, sessions, intake } = setup();
		threadOf(d, "t5");
		await sessions.set("t5", "gone");
		d.history.set("t5", [
			{
				id: "t5",
				authorId: "u1",
				authorName: "ちゃぬ",
				isBot: false,
				content: "最初の依頼",
			},
			{
				id: "a",
				authorId: BOT,
				authorName: "ゆかり",
				isBot: true,
				content: "やりました",
			},
			{
				id: "r",
				authorId: "u1",
				authorName: "ちゃぬ",
				isBot: false,
				content: "続きを",
			},
		]);
		await intake.handle(
			envelope({
				channel_id: "t5",
				message_id: "r",
				mentions: [],
				content: "続きを",
			}),
		);
		const calls = c.runner.run.mock.calls.map(([i]) => i);
		expect(calls[0]?.session).toEqual({ kind: "resume", id: "gone" });
		expect(calls[1]?.session).toEqual({ kind: "new", id: "s1" });
		expect(calls[1]?.prompt).toContain("[あなた] やりました");
		expect(calls[1]?.prompt).toContain("[ちゃぬ] 続きを");
		expect(sessions.get("t5")).toBe("s1");
	});

	it("フォーラム外のチャンネルは無視する", async () => {
		const { d, c, intake } = setup();
		d.channels.set("misc", {
			id: "misc",
			name: "x",
			parentId: "cat",
			appliedTagIds: [],
			availableTags: [],
		});
		await intake.handle(envelope({ channel_id: "misc", mentions: [] }));
		expect(c.runner.run).not.toHaveBeenCalled();
	});

	it("同じ投稿への返事は前の作業が終わってから流す", async () => {
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const { d, c, sessions, intake } = setup();
		threadOf(d, "t7");
		await sessions.set("t7", "s-old");
		c.known.add("s-old");
		const order: string[] = [];
		c.runner.run.mockImplementation(async ({ prompt, session }) => {
			order.push(`start:${prompt.split(": ").at(-1)}`);
			if (prompt.endsWith("一つ目")) await gate;
			order.push(`end:${prompt.split(": ").at(-1)}`);
			return ok({ sessionId: session.id, text: "ok\n状態: 完了" });
		});
		const a = intake.handle(
			envelope({
				channel_id: "t7",
				message_id: "a",
				mentions: [],
				content: "一つ目",
			}),
		);
		const b = intake.handle(
			envelope({
				channel_id: "t7",
				message_id: "b",
				mentions: [],
				content: "二つ目",
			}),
		);
		await new Promise((r) => setTimeout(r, 10));
		expect(order).toEqual(["start:一つ目"]);
		release();
		await Promise.all([a, b]);
		expect(order).toEqual([
			"start:一つ目",
			"end:一つ目",
			"start:二つ目",
			"end:二つ目",
		]);
	});

	it("Claude が失敗したら投稿で知らせ、決めてほしいにする", async () => {
		const { d, c, sessions, intake } = setup();
		threadOf(d, "t8");
		await sessions.set("t8", "s-old");
		c.runner.run.mockResolvedValueOnce({
			ok: false,
			error: { type: "ClaudeFailed", reason: "x" },
		});
		await intake.handle(
			envelope({
				channel_id: "t8",
				message_id: "z",
				mentions: [],
				content: "どう？",
			}),
		);
		expect(d.sent[0]?.channelId).toBe("t8");
		expect(d.channels.get("t8")?.appliedTagIds).toEqual([
			"tag-other",
			"tag-decide",
		]);
	});
});
