import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	err,
	externalServiceUnavailable,
	ok,
	permissionDenied,
} from "@yunomi/core";
import type { DiscordMessageCreatedEnvelope } from "@yunomi/protocol";
import { vi } from "vitest";
import type { ApprovalRequest, ApprovalStore } from "./approval-store.ts";
import type { ChannelInfo, DiscordApi, PostedMessage } from "./discord-rest.ts";
import { createLedger } from "./guard/ledger.ts";
import type { Orca, SeatHandle, SeatMessage } from "./orca.ts";

export const memoryApprovals = (): ApprovalStore & {
	all: Map<string, ApprovalRequest>;
} => {
	const all = new Map<string, ApprovalRequest>();
	return {
		all,
		get: (id) => all.get(id) ?? null,
		set: async (id, r) => {
			all.set(id, r);
		},
		delete: async (id) => {
			all.delete(id);
		},
	};
};

export const tempDir = (prefix = "yunomi-working-") =>
	mkdtempSync(join(tmpdir(), prefix));

export const tempLedger = (dir = tempDir()) => createLedger(dir);

export const BOT = "bot";
export const OWNER = "u1";
export const TEXT = "text";
export const FORUM = "forum";
export const TAGS = [
	{ id: "tag-decide", name: "決めてほしい" },
	{ id: "tag-working", name: "作業中" },
	{ id: "tag-handoff", name: "引き継ぎ" },
	{ id: "tag-done", name: "完了" },
	{ id: "tag-other", name: "その他" },
];

/** Discord REST のモック。投稿・送信・タグを手元に残す。 */
export const fakeDiscord = () => {
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
	const refuseSendTo = new Set<string>();
	const sent: { channelId: string; content: string; replyTo?: string }[] = [];
	const posts: { name: string; content: string; tagIds: string[] }[] = [];
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
				posts.push(post);
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
			if (refuseSendTo.has(channelId)) {
				return err(
					permissionDenied({ actor: "discord bot", action: "POST /channels" }),
				);
			}
			sent.push({ channelId, content, ...(replyTo ? { replyTo } : {}) });
			return ok({ messageIds: [`sent${sent.length}`] });
		},
		setTags: async (threadId, tagIds) => {
			const ch = channels.get(threadId);
			if (ch) channels.set(threadId, { ...ch, appliedTagIds: tagIds });
			return ok(undefined);
		},
	};
	const addThread = (id: string, name: string) =>
		channels.set(id, {
			id,
			name,
			parentId: FORUM,
			appliedTagIds: [],
			availableTags: [],
		});
	const tagsOf = (id: string) => channels.get(id)?.appliedTagIds ?? [];
	const sentTo = (id: string) =>
		sent.filter((s) => s.channelId === id).map((s) => s.content);
	return {
		api,
		channels,
		messages,
		sent,
		posts,
		history,
		refuseSendTo,
		addThread,
		tagsOf,
		sentTo,
	};
};

/**
 * Orca のモック。席を作る・続きを渡す・止める・消す、を呼ばれた順に残す。
 * 席から受付に届くメッセージは、テストが intake.onSeatMessage に直接渡す。
 */
export const fakeOrca = (seatsDir = "/seats") => {
	let n = 0;
	const calls: { op: string; args: unknown }[] = [];
	const live = new Set<string>();
	const worktrees = new Set<string>();
	const strayTerminals: { handle: string; path: string }[] = [];
	const handle = (path: string): SeatHandle => {
		n++;
		const h = { dispatchId: `d${n}`, terminal: `t${n}`, path };
		live.add(h.terminal);
		return h;
	};
	const orca: Orca = {
		prepare: vi.fn(async () => ok({ runId: "run1", reception: "rx" })),
		startSeat: vi.fn(async (input) => {
			calls.push({ op: "startSeat", args: input });
			const path = `${seatsDir}/${input.name}`;
			worktrees.add(path);
			return ok(handle(path));
		}),
		resumeSeat: vi.fn(async (input) => {
			calls.push({ op: "resumeSeat", args: input });
			return ok(handle(input.path));
		}),
		send: vi.fn(async (input) => {
			calls.push({ op: "send", args: input });
			n++;
			return ok({ dispatchId: `d${n}`, terminal: null });
		}),
		reply: vi.fn(async (input) => {
			calls.push({ op: "reply", args: input });
			return ok(undefined);
		}),
		stopSeat: vi.fn(async (seat) => {
			calls.push({ op: "stopSeat", args: seat });
			if (seat.terminal) live.delete(seat.terminal);
			return ok(undefined);
		}),
		removeWorktree: vi.fn(async (path) => {
			calls.push({ op: "removeWorktree", args: path });
			worktrees.delete(path);
			return ok(undefined);
		}),
		closeTerminal: vi.fn(async (h) => {
			calls.push({ op: "closeTerminal", args: h });
			live.delete(h);
			return ok(undefined);
		}),
		liveTerminals: vi.fn(async () => ok(new Set(live))),
		residue: vi.fn(async () =>
			ok({ worktrees: [...worktrees], terminals: [...strayTerminals] }),
		),
		waitMessages: vi.fn(async () => ok([])),
	};
	const opsOf = (op: string) =>
		calls.filter((c) => c.op === op).map((c) => c.args);
	return { orca, calls, live, worktrees, strayTerminals, opsOf };
};

let seq = 0;
export const seatMessage = (
	m: Partial<SeatMessage> & Pick<SeatMessage, "type" | "dispatchId">,
): SeatMessage => ({
	id: `msg${++seq}`,
	subject: "",
	body: "",
	outcome: null,
	stopReason: null,
	...m,
});

export const envelope = (
	payload: Partial<DiscordMessageCreatedEnvelope["payload"]>,
): DiscordMessageCreatedEnvelope =>
	({
		event_id: `e${++seq}`,
		payload: {
			guild_id: "g",
			channel_id: TEXT,
			message_id: `m${seq}`,
			author: { id: OWNER, display_name: "ちゃぬ", is_bot: false },
			content: "<@123> 請求書を整理して",
			mentions: [BOT],
			reply_to_message_id: null,
			attachments: [],
			...payload,
		},
	}) as DiscordMessageCreatedEnvelope;

/** 投稿内の持ち主の発言。 */
export const say = (
	threadId: string,
	content: string,
	opts: { first?: boolean; replyTo?: string } = {},
) =>
	envelope({
		channel_id: threadId,
		...(opts.first ? { message_id: threadId } : {}),
		content,
		mentions: [],
		reply_to_message_id: opts.replyTo ?? null,
	});
