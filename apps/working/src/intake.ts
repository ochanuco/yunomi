import { randomUUID } from "node:crypto";
import type { DiscordMessageCreatedEnvelope } from "@yunomi/protocol";
import {
	approvalRequestText,
	approvedNote,
	approvedPrompt,
	isApproval,
	uniquePending,
} from "./approval.ts";
import type { ApprovalStore } from "./approval-store.ts";
import type { ClaudeRunner, GuardRunInput } from "./claude-cli.ts";
import type { DiscordApi } from "./discord-rest.ts";
import type { Ledger } from "./guard/ledger.ts";
import { type Operation, sameOperation } from "./guard/operation.ts";
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
	/** 投稿で許可を待っている操作。 */
	approvals: ApprovalStore;
	/** hook が止めた操作と、許可の記録。 */
	ledger: Ledger;
	botUserId: string;
	/** この人たちの発言だけで作業する。 */
	ownerUserIds: ReadonlySet<string>;
	workTextChannelId: string;
	workForumChannelId: string;
	newSessionId: () => string;
	newGrantId?: () => string;
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
	const newGrantId = deps.newGrantId ?? randomUUID;
	const queue = createKeyedQueue();
	const parentOf = new Map<string, string | null>();
	let tagIds: Map<WorkStatus, string> | null = null;
	// 投稿に書けなかった最後の返事。セッションには残っているので、次の発言のときに先に出し直す
	const undelivered = new Map<string, string>();

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

	/** 1 回の作業で hook が止めた操作を投稿に書き、許可を待つ。 */
	const requestApproval = async (threadId: string): Promise<boolean> => {
		const blocked = uniquePending(deps.ledger.takePending(threadId));
		if (blocked.length === 0) return false;
		const sent = await deps.discord.send(
			threadId,
			approvalRequestText(blocked),
		);
		if (!sent.ok) {
			log.error("approval request failed", {
				thread_id: threadId,
				error: sent.error.type,
			});
			return true;
		}
		const operations = blocked.map((b) => b.operation);
		const messageId = sent.value.messageIds[0] ?? "";
		await deps.approvals.set(threadId, {
			messageIds: sent.value.messageIds,
			operations,
		});
		deps.ledger.log({
			event: "requested",
			thread_id: threadId,
			message_id: messageId,
			operations,
		});
		log.info("approval requested", { thread_id: threadId, operations });
		return true;
	};

	/** 許可したのに使われなかった操作は、その回かぎりで失効させる。 */
	const expireGrant = (threadId: string, guard: GuardRunInput) => {
		if (guard.grantId === null) return;
		const used = deps.ledger.used(guard.grantId);
		const unused = guard.grants.filter(
			(g) => !used.some((u) => sameOperation(u, g)),
		);
		deps.ledger.clearUsed(guard.grantId);
		if (unused.length === 0) return;
		deps.ledger.log({
			event: "expired",
			thread_id: threadId,
			grant_id: guard.grantId,
			operations: unused,
		});
		log.info("approval expired unused", {
			thread_id: threadId,
			operations: unused,
		});
	};

	/** Claude に投げ、返事を投稿に書いてタグを付け替える。 */
	const work = async (
		threadId: string,
		first:
			| { sessionId: string; prompt: string }
			| { reply: Payload; prompt: string },
		granted: {
			grantId: string;
			operations: readonly Operation[];
		} | null = null,
	) => {
		const unsent = undelivered.get(threadId);
		if (unsent !== undefined) {
			const resent = await deps.discord.send(threadId, unsent);
			if (resent.ok) {
				undelivered.delete(threadId);
				log.info("undelivered reply resent", { thread_id: threadId });
			} else {
				log.error("resend failed", {
					thread_id: threadId,
					error: resent.error.type,
				});
			}
		}
		await setStatus(threadId, "作業中");
		const guard: GuardRunInput = {
			threadId,
			grants: granted?.operations ?? [],
			grantId: granted?.grantId ?? null,
		};
		let result: Awaited<ReturnType<ClaudeRunner["run"]>>;
		if ("sessionId" in first) {
			result = await deps.claude.run({
				prompt: first.prompt,
				session: { kind: "new", id: first.sessionId },
				guard,
			});
		} else {
			const known = deps.sessions.get(threadId);
			result = known
				? await deps.claude.run({
						prompt: first.prompt,
						session: { kind: "resume", id: known },
						guard,
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
				const recovery = recoveryPrompt({
					now: now(),
					title: thread.ok ? thread.value.name : null,
					history: history.ok ? history.value : [],
					botUserId: deps.botUserId,
				});
				result = await deps.claude.run({
					prompt: granted
						? `${recovery}\n\n${approvedNote(granted.operations)}`
						: recovery,
					session: { kind: "new", id: sessionId },
					guard,
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
			expireGrant(threadId, guard);
			await deps.discord.send(threadId, FAILURE_TEXT);
			await requestApproval(threadId);
			await setStatus(threadId, "決めてほしい");
			return;
		}
		expireGrant(threadId, guard);
		await deps.sessions.set(threadId, result.value.sessionId);
		const taken = takeStatus(result.value.text);
		const body = taken.body;
		if (body !== "") {
			const sent = await deps.discord.send(threadId, body);
			if (!sent.ok) {
				// 返事が届いていないので完了にはしない。止めた操作の依頼も次の回まで持ち越す
				undelivered.set(threadId, body);
				log.error("reply failed", {
					thread_id: threadId,
					error: sent.error.type,
				});
				await setStatus(threadId, "決めてほしい");
				log.warn("work turn undelivered", { thread_id: threadId });
				return;
			}
			undelivered.delete(threadId);
		}
		// 止めた操作があれば、Claude の書いた状態によらず持ち主の判断を待つ
		const status = (await requestApproval(threadId))
			? "決めてほしい"
			: taken.status;
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

	/** 投稿内の返事。許可を待っている操作があれば、許可かどうかを先に見る。 */
	const answer = async (threadId: string, p: Payload) => {
		const reply = {
			reply: p,
			prompt: replyPrompt({
				now: now(),
				authorName: p.author.display_name,
				content: p.content,
			}),
		};
		const request = deps.approvals.get(threadId);
		if (request === null) {
			await work(threadId, reply);
			return;
		}
		// 許可でも取りやめでも、待っていた操作はここで片付け、古い依頼に後から OK を返しても通さない
		await deps.approvals.delete(threadId);
		if (
			!isApproval(
				{ content: p.content, replyToMessageId: p.reply_to_message_id ?? null },
				request,
			)
		) {
			deps.ledger.log({
				event: "dismissed",
				thread_id: threadId,
				operations: [...request.operations],
			});
			log.info("approval dismissed", { thread_id: threadId });
			await work(threadId, reply);
			return;
		}
		const grantId = newGrantId();
		deps.ledger.log({
			event: "granted",
			thread_id: threadId,
			grant_id: grantId,
			message_id: p.message_id,
			operations: [...request.operations],
		});
		log.info("approval granted", {
			thread_id: threadId,
			grant_id: grantId,
			operations: request.operations,
		});
		await work(
			threadId,
			{
				reply: p,
				prompt: approvedPrompt({
					now: now(),
					authorName: p.author.display_name,
					content: p.content,
					operations: request.operations,
				}),
			},
			{ grantId, operations: request.operations },
		);
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
			await queue.run(threadId, () => answer(threadId, p));
		},
	};
};
