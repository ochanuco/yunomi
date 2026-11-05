import type { DiscordMessageCreatedEnvelope } from "@yunomi/protocol";
import type { ClaudeRunner } from "./claude-cli.ts";
import type { DiscordApi } from "./discord-rest.ts";
import { createKeyedQueue } from "./keyed-queue.ts";
import type { Logger } from "./logger.ts";
import {
	fallbackTitle,
	forumPostBody,
	forumStarterPrompt,
	messageLink,
	recoveryPrompt,
	replyPrompt,
	requestPrompt,
} from "./prompts.ts";
import type { SessionStore } from "./session-store.ts";
import {
	replaceStatusTag,
	takeStatus,
	WORK_STATUSES,
	type WorkStatus,
} from "./work-status.ts";

export type IntakeDeps = {
	discord: DiscordApi;
	claude: ClaudeRunner;
	sessions: SessionStore;
	botUserId: string;
	/** この人たちの発言だけで作業する。 */
	ownerUserIds: ReadonlySet<string>;
	workTextChannelId: string;
	workForumChannelId: string;
	newSessionId: () => string;
	now?: () => Date;
	logger: Logger;
};

type Payload = DiscordMessageCreatedEnvelope["payload"];

const HISTORY_LIMIT = 100;
const FAILURE_TEXT =
	"うまく進められませんでした。少し置いてから、もう一度声をかけてください。";

export type Intake = {
	/** 受け付けた仕事が終わるまで待つ Promise を返す。HTTP は待たずに 202 を返す。 */
	handle: (envelope: DiscordMessageCreatedEnvelope) => Promise<void>;
};

export const createIntake = (deps: IntakeDeps): Intake => {
	const log = deps.logger;
	const now = deps.now ?? (() => new Date());
	const queue = createKeyedQueue();
	const parentOf = new Map<string, string | null>();
	let tagIds: Map<WorkStatus, string> | null = null;

	const statusTags = async (): Promise<Map<WorkStatus, string>> => {
		if (tagIds) return tagIds;
		const forum = await deps.discord.getChannel(deps.workForumChannelId);
		if (!forum.ok) {
			log.warn("forum tags unavailable", { error: forum.error.type });
			return new Map();
		}
		const found = new Map<WorkStatus, string>();
		for (const name of WORK_STATUSES) {
			const tag = forum.value.availableTags.find((t) => t.name === name);
			if (tag) found.set(name, tag.id);
			else log.warn("forum tag missing", { tag: name });
		}
		tagIds = found;
		return found;
	};

	const setStatus = async (threadId: string, status: WorkStatus) => {
		const tags = await statusTags();
		const thread = await deps.discord.getChannel(threadId);
		if (!thread.ok) {
			log.warn("thread lookup failed", { thread_id: threadId });
			return;
		}
		const next = replaceStatusTag(thread.value.appliedTagIds, tags, status);
		const same =
			next.length === thread.value.appliedTagIds.length &&
			next.every((id) => thread.value.appliedTagIds.includes(id));
		if (same) return;
		const r = await deps.discord.setTags(threadId, next);
		if (!r.ok) {
			log.warn("set tags failed", { thread_id: threadId, error: r.error.type });
		}
	};

	const parentIdOf = async (channelId: string): Promise<string | null> => {
		const cached = parentOf.get(channelId);
		if (cached !== undefined) return cached;
		const ch = await deps.discord.getChannel(channelId);
		if (!ch.ok) return null;
		parentOf.set(channelId, ch.value.parentId);
		return ch.value.parentId;
	};

	const isAddressed = async (p: Payload): Promise<boolean> => {
		if (p.mentions.includes(deps.botUserId)) return true;
		if (!p.reply_to_message_id) return false;
		const replied = await deps.discord.getMessage(
			p.channel_id,
			p.reply_to_message_id,
		);
		return replied.ok && replied.value.authorId === deps.botUserId;
	};

	/** Claude に投げ、返事を投稿に書いてタグを付け替える。 */
	const work = async (
		threadId: string,
		first: { sessionId: string; prompt: string } | { reply: Payload },
	) => {
		await setStatus(threadId, "作業中");
		let result: Awaited<ReturnType<ClaudeRunner["run"]>>;
		if ("sessionId" in first) {
			result = await deps.claude.run({
				prompt: first.prompt,
				session: { kind: "new", id: first.sessionId },
			});
		} else {
			const known = deps.sessions.get(threadId);
			result = known
				? await deps.claude.run({
						prompt: replyPrompt({
							now: now(),
							authorName: first.reply.author.display_name,
							content: first.reply.content,
						}),
						session: { kind: "resume", id: known },
					})
				: { ok: false, error: { type: "SessionNotFound", sessionId: "" } };
			if (!result.ok && result.error.type === "SessionNotFound") {
				log.info("session lost; resuming from history", {
					thread_id: threadId,
				});
				const [history, thread] = await Promise.all([
					deps.discord.listMessages(threadId, HISTORY_LIMIT),
					deps.discord.getChannel(threadId),
				]);
				const sessionId = deps.newSessionId();
				await deps.sessions.set(threadId, sessionId);
				result = await deps.claude.run({
					prompt: recoveryPrompt({
						now: now(),
						title: thread.ok ? thread.value.name : null,
						history: history.ok ? history.value : [],
						botUserId: deps.botUserId,
					}),
					session: { kind: "new", id: sessionId },
				});
			}
		}

		if (!result.ok) {
			log.error("claude failed", {
				thread_id: threadId,
				error: result.error.type,
				reason:
					result.error.type === "ClaudeFailed"
						? result.error.reason
						: undefined,
			});
			await deps.discord.send(threadId, FAILURE_TEXT);
			await setStatus(threadId, "決めてほしい");
			return;
		}
		await deps.sessions.set(threadId, result.value.sessionId);
		const { body, status } = takeStatus(result.value.text);
		if (body !== "") {
			const sent = await deps.discord.send(threadId, body);
			if (!sent.ok) {
				log.error("reply failed", {
					thread_id: threadId,
					error: sent.error.type,
				});
			}
		}
		await setStatus(threadId, status);
		log.info("work turn done", { thread_id: threadId, status });
	};

	const startFromRequest = async (p: Payload) => {
		const summary = await deps.claude.summarize(p.content);
		const title = summary.ok ? summary.value : fallbackTitle(p.content);
		const link = messageLink(p.guild_id, p.channel_id, p.message_id);
		const tags = await statusTags();
		const working = tags.get("作業中");
		const post = await deps.discord.createForumPost(deps.workForumChannelId, {
			name: title,
			content: forumPostBody({
				authorName: p.author.display_name,
				content: p.content,
				link,
			}),
			tagIds: working ? [working] : [],
		});
		if (!post.ok) {
			log.error("forum post failed", {
				message_id: p.message_id,
				error: post.error.type,
			});
			await deps.discord.send(
				p.channel_id,
				"フォーラムに投稿を立てられませんでした。少し置いてから、もう一度お願いします。",
				p.message_id,
			);
			return;
		}
		const { threadId } = post.value;
		parentOf.set(threadId, deps.workForumChannelId);
		const sessionId = deps.newSessionId();
		// 投稿内の返事が先に届いても続きとして扱えるよう、Claude を呼ぶ前に対応を残す
		await deps.sessions.set(threadId, sessionId);
		log.info("forum post created", {
			message_id: p.message_id,
			thread_id: threadId,
		});
		await deps.discord.send(
			p.channel_id,
			`フォーラムに立てました。続きはこちらで → ${messageLink(p.guild_id, threadId)}`,
			p.message_id,
		);
		await queue.run(threadId, () =>
			work(threadId, {
				sessionId,
				prompt: requestPrompt({
					now: now(),
					authorName: p.author.display_name,
					content: p.content,
					link,
				}),
			}),
		);
	};

	const startFromForumPost = async (p: Payload) => {
		const threadId = p.channel_id;
		const thread = await deps.discord.getChannel(threadId);
		const sessionId = deps.newSessionId();
		await deps.sessions.set(threadId, sessionId);
		log.info("forum post received", { thread_id: threadId });
		await work(threadId, {
			sessionId,
			prompt: forumStarterPrompt({
				now: now(),
				authorName: p.author.display_name,
				title: thread.ok ? thread.value.name : null,
				content: p.content,
			}),
		});
	};

	return {
		handle: async (envelope) => {
			const p = envelope.payload;
			if (p.author.id === deps.botUserId) return;
			// 持ち主以外の人やほかの bot の発言で Claude CLI を動かさない
			if (p.author.is_bot || !deps.ownerUserIds.has(p.author.id)) {
				log.debug("message from non-owner ignored", {
					message_id: p.message_id,
					author_id: p.author.id,
				});
				return;
			}

			if (p.channel_id === deps.workTextChannelId) {
				if (!(await isAddressed(p))) return;
				await startFromRequest(p);
				return;
			}

			if ((await parentIdOf(p.channel_id)) !== deps.workForumChannelId) return;
			const threadId = p.channel_id;
			// フォーラム投稿の最初のメッセージは投稿（スレッド）と同じ ID を持つ
			if (p.message_id === threadId && deps.sessions.get(threadId) === null) {
				await queue.run(threadId, () => startFromForumPost(p));
				return;
			}
			await queue.run(threadId, () => work(threadId, { reply: p }));
		},
	};
};
