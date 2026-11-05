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
import type { Summarizer } from "./claude-cli.ts";
import type { DiscordApi } from "./discord-rest.ts";
import { seatNameOf } from "./guard/env.ts";
import type { Ledger, Pending } from "./guard/ledger.ts";
import type { Operation } from "./guard/operation.ts";
import { createKeyedQueue } from "./keyed-queue.ts";
import type { Logger } from "./logger.ts";
import type { Orca, SeatMessage } from "./orca.ts";
import {
	fallbackTitle,
	forumPostBody,
	forumStarterPrompt,
	historyPrompt,
	messageLink,
	replyPrompt,
	requestPrompt,
	seatSpec,
	wakeNote,
} from "./prompts.ts";
import { newSeat, type Seat, type SeatStore } from "./seat-store.ts";
import {
	replaceStatusTag,
	takeStatus,
	WORK_STATUSES,
	type WorkStatus,
} from "./work-status.ts";

export type IntakeDeps = {
	discord: DiscordApi;
	orca: Orca;
	seats: SeatStore;
	/** 投稿で許可を待っている操作。 */
	approvals: ApprovalStore;
	/** hook が止めた操作と、許可の記録。 */
	ledger: Ledger;
	summarize: Summarizer;
	/** 終わった仕事を記憶に 1 行残す。 */
	remember: (summary: string) => Promise<void>;
	/** 朝会の席が返した決めてほしいことを投稿にする。 */
	standupDone: (text: string, blocked: readonly Pending[]) => Promise<void>;
	/** 新しい席に最初に渡す前置き（人格、仕事のしかた、引き継ぎの指示）。 */
	preamble: string;
	botUserId: string;
	/** この人たちの発言だけで作業する。 */
	ownerUserIds: ReadonlySet<string>;
	workTextChannelId: string;
	workForumChannelId: string;
	/** 同時に Claude を動かしておく席の上限。止めた席と順番待ちは数えない。 */
	seatLimit: number;
	/** 決めてほしいままこれだけたった席は Claude を止める。 */
	sleepAfterMs: number;
	newGrantId?: () => string;
	now?: () => Date;
	logger: Logger;
};

type Payload = DiscordMessageCreatedEnvelope["payload"];

const HISTORY_LIMIT = 100;
const FAILURE_TEXT =
	"うまく進められませんでした。少し置いてから、もう一度声をかけてください。";
const QUEUED_TEXT =
	"いまは席がすべてふさがっているので、順番待ちにしました。空いたら始めます。";
const STOPPED_TEXT =
	"作業が途中で止まりました。返事をくれれば、そこから続けます。";
const RESTARTED_TEXT =
	"受付を作り直したので、作業が途中で止まりました。返事をくれれば、そこから続けます。";
const STANDUP_NO_ASK =
	"朝会では持ち主に聞けない。聞きたいことは決めてほしいことに入れて、JSON で返す。";

const ALIVE = new Set(["working", "asking", "waiting"]);

export type Intake = {
	/** 受け付けた仕事が終わるまで待つ Promise を返す。HTTP は待たずに 202 を返す。 */
	handle: (envelope: DiscordMessageCreatedEnvelope) => Promise<void>;
	/** 席から届いたメッセージ（質問、完了の報告、止まった知らせ）を投稿に運ぶ。 */
	onSeatMessage: (msg: SeatMessage) => Promise<void>;
	/** 朝会の席を作る。席の名前にする ID を返す。 */
	startStandup: (spec: string) => Promise<string>;
	/** 決めてほしいまま時間がたった席の Claude を止める。 */
	sleepIdle: () => Promise<void>;
	/** 起動時に、対応表と Orca の席を突き合わせる。 */
	reconcile: () => Promise<void>;
};

export const createIntake = (deps: IntakeDeps): Intake => {
	const log = deps.logger;
	const now = deps.now ?? (() => new Date());
	const newGrantId = deps.newGrantId ?? randomUUID;
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

	const titleOf = async (threadId: string): Promise<string | null> => {
		const ch = await deps.discord.getChannel(threadId);
		return ch.ok ? ch.value.name : null;
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

	const alive = () => deps.seats.all().filter((s) => ALIVE.has(s.status));

	/** 許可したのに使われなかった操作は、その回かぎりで失効させる。 */
	const expireGrant = (threadId: string) => {
		const grant = deps.ledger.takeGrant(threadId);
		if (grant === null) return;
		const used = deps.ledger.used(grant.grant_id);
		const unused = grant.operations.filter(
			(g) => !used.some((u) => u.tool === g.tool && u.target === g.target),
		);
		deps.ledger.clearUsed(grant.grant_id);
		if (unused.length === 0) return;
		deps.ledger.log({
			event: "expired",
			thread_id: threadId,
			grant_id: grant.grant_id,
			operations: unused,
		});
		log.info("approval expired unused", {
			thread_id: threadId,
			operations: unused,
		});
	};

	/** hook が止めた操作を投稿に書き、許可を待つ。lead は同じメッセージの頭に置く文。 */
	const postWithApproval = async (
		threadId: string,
		lead: string,
		blocked: readonly Pending[],
	) => {
		if (blocked.length === 0) {
			if (lead.trim() === "") return;
			const sent = await deps.discord.send(threadId, lead);
			if (!sent.ok) {
				log.error("post failed", {
					thread_id: threadId,
					error: sent.error.type,
				});
			}
			return;
		}
		const request = approvalRequestText(blocked);
		const sent = await deps.discord.send(
			threadId,
			lead.trim() === "" ? request : `${lead}\n\n${request}`,
		);
		if (!sent.ok) {
			log.error("approval request failed", {
				thread_id: threadId,
				error: sent.error.type,
			});
			return;
		}
		const operations = blocked.map((b) => b.operation);
		await deps.approvals.set(threadId, {
			messageIds: sent.value.messageIds,
			operations,
		});
		deps.ledger.log({
			event: "requested",
			thread_id: threadId,
			message_id: sent.value.messageIds[0] ?? "",
			operations,
		});
		log.info("approval requested", { thread_id: threadId, operations });
	};

	/** 空いた席の数だけ、順番待ちの投稿を始める。 */
	const dequeue = () => {
		const free = deps.seatLimit - alive().length;
		if (free <= 0) return;
		const waiting = deps.seats
			.all()
			.filter((s) => s.status === "queued")
			.sort(
				(a, b) => (a.queuedAt?.getTime() ?? 0) - (b.queuedAt?.getTime() ?? 0),
			)
			.slice(0, free);
		for (const s of waiting) {
			void queue.run(s.threadId, async () => {
				const seat = deps.seats.get(s.threadId);
				if (seat?.status !== "queued") return;
				if (alive().length >= deps.seatLimit) return;
				await launch(seat);
			});
		}
	};

	/** 席に Claude を座らせ、溜まっている言葉を渡す。worktree があれば前の会話のまま起こす。 */
	const launch = async (seat: Seat) => {
		const threadId = seat.threadId;
		const title = (await titleOf(threadId)) ?? threadId;
		const text = seat.pending.join("\n\n---\n\n");
		const r = seat.path
			? await deps.orca.resumeSeat({ path: seat.path, title, spec: text })
			: await deps.orca.startSeat({
					name: seatNameOf(threadId),
					title,
					spec: seatSpec(deps.preamble, text),
				});
		if (!r.ok) {
			log.error("seat start failed", {
				thread_id: threadId,
				reason: r.error.reason,
			});
			// worktree が無ければ席ごと忘れ、次の返事でやりとりを読ませて作り直す
			if (seat.path) {
				await deps.seats.set({ ...seat, status: "sleeping", pending: [] });
			} else {
				await deps.seats.delete(threadId);
			}
			if (!seat.standup) {
				await deps.discord.send(threadId, FAILURE_TEXT);
				await setStatus(threadId, "決めてほしい");
			}
			return;
		}
		await deps.seats.set({
			...seat,
			status: "working",
			path: r.value.path,
			terminal: r.value.terminal,
			dispatchId: r.value.dispatchId,
			dispatchIds: [...seat.dispatchIds, r.value.dispatchId],
			questionId: null,
			question: null,
			expectStop: false,
			waitingSince: null,
			pending: [],
			queuedAt: null,
		});
		log.info("seat working", {
			thread_id: threadId,
			dispatch_id: r.value.dispatchId,
			resumed: seat.path !== null,
		});
		if (!seat.standup) await setStatus(threadId, "作業中");
	};

	/** 席を作るか、上限なら順番待ちにする。 */
	const openSeat = async (seat: Seat, text: string) => {
		const next = { ...seat, pending: [...seat.pending, text] };
		if (!seat.standup && alive().length >= deps.seatLimit) {
			await deps.seats.set({ ...next, status: "queued", queuedAt: now() });
			log.info("seat queued", { thread_id: seat.threadId });
			await deps.discord.send(seat.threadId, QUEUED_TEXT);
			return;
		}
		await launch(next);
	};

	/** 席の Claude を止め、worktree を消して対応を忘れる。 */
	const closeSeat = async (seat: Seat) => {
		const stopped = await deps.orca.stopSeat(seat);
		if (!stopped.ok) {
			log.error("seat stop failed", {
				thread_id: seat.threadId,
				reason: stopped.error.reason,
			});
		}
		if (seat.path) {
			const removed = await deps.orca.removeWorktree(seat.path);
			if (!removed.ok) {
				log.error("seat worktree remove failed", {
					thread_id: seat.threadId,
					reason: removed.error.reason,
				});
			}
		}
		await deps.seats.delete(seat.threadId);
		log.info("seat closed", { thread_id: seat.threadId });
		dequeue();
	};

	const toWaiting = (
		seat: Seat,
		ask: { id: string; text: string } | null,
	): Seat => ({
		...seat,
		status: ask ? "asking" : "waiting",
		questionId: ask?.id ?? null,
		question: ask?.text ?? seat.question,
		expectStop: ask !== null,
		waitingSince: now(),
	});

	/** 持ち主の言葉を席に渡す。席の状態で渡し方が変わる。 */
	const deliver = async (
		threadId: string,
		text: string,
		granted: readonly Operation[] | null,
	) => {
		const seat = deps.seats.get(threadId);
		if (seat === null) {
			// 席が無い（完了したあと、朝会の投稿、作れなかった）ときは、やりとりを読ませて新しい席を作る
			const [history, title] = await Promise.all([
				deps.discord.listMessages(threadId, HISTORY_LIMIT),
				titleOf(threadId),
			]);
			const prompt = historyPrompt({
				now: now(),
				title,
				history: history.ok ? history.value : [],
				botUserId: deps.botUserId,
			});
			await openSeat(
				newSeat(threadId),
				granted ? `${prompt}\n\n${approvedNote(granted)}` : prompt,
			);
			return;
		}
		switch (seat.status) {
			case "queued":
				await deps.seats.set({ ...seat, pending: [...seat.pending, text] });
				return;
			case "sleeping": {
				const woke = {
					...seat,
					pending: [`${wakeNote(seat.question)}\n\n${text}`],
				};
				if (alive().length >= deps.seatLimit) {
					await deps.seats.set({ ...woke, status: "queued", queuedAt: now() });
					await deps.discord.send(threadId, QUEUED_TEXT);
					return;
				}
				await launch(woke);
				return;
			}
			case "asking":
				if (seat.questionId) {
					const r = await deps.orca.reply({
						messageId: seat.questionId,
						body: text,
					});
					if (r.ok) {
						await deps.seats.set({
							...seat,
							status: "working",
							questionId: null,
							waitingSince: null,
						});
						await setStatus(threadId, "作業中");
						return;
					}
					log.warn("seat reply failed; sending instead", {
						thread_id: threadId,
						reason: r.error.reason,
					});
				}
				break;
			case "working":
			case "waiting":
				break;
		}
		if (seat.dispatchId === null) return;
		const sent = await deps.orca.send({
			dispatchId: seat.dispatchId,
			subject: "持ち主の返事",
			body: text,
		});
		if (!sent.ok) {
			log.error("seat send failed", {
				thread_id: threadId,
				reason: sent.error.reason,
			});
			await deps.discord.send(threadId, FAILURE_TEXT);
			return;
		}
		await deps.seats.set({
			...seat,
			status: "working",
			terminal: sent.value.terminal ?? seat.terminal,
			dispatchId: sent.value.dispatchId,
			dispatchIds: seat.dispatchIds.includes(sent.value.dispatchId)
				? seat.dispatchIds
				: [...seat.dispatchIds, sent.value.dispatchId],
			questionId: null,
			waitingSince: null,
		});
		await setStatus(threadId, "作業中");
	};

	const onQuestion = async (seat: Seat, msg: SeatMessage) => {
		const threadId = seat.threadId;
		if (seat.standup) {
			await deps.orca.reply({ messageId: msg.id, body: STANDUP_NO_ASK });
			return;
		}
		expireGrant(threadId);
		const blocked = uniquePending(deps.ledger.takePending(threadId));
		await postWithApproval(threadId, msg.body, blocked);
		await deps.seats.set(toWaiting(seat, { id: msg.id, text: msg.body }));
		await setStatus(threadId, "決めてほしい");
		log.info("seat asked", { thread_id: threadId, blocked: blocked.length });
	};

	const onDone = async (seat: Seat, msg: SeatMessage) => {
		const threadId = seat.threadId;
		expireGrant(threadId);
		const blocked = uniquePending(deps.ledger.takePending(threadId));
		if (seat.standup) {
			await deps.standupDone(msg.body, blocked);
			await closeSeat(seat);
			return;
		}
		const taken = takeStatus(msg.body);
		// 止めた操作があれば、Claude の書いた状態によらず持ち主の判断を待つ
		if (
			blocked.length > 0 ||
			msg.outcome === "failed" ||
			taken.status === "決めてほしい"
		) {
			await postWithApproval(threadId, taken.body, blocked);
			await deps.seats.set({ ...toWaiting(seat, null), expectStop: false });
			await setStatus(threadId, "決めてほしい");
			log.info("seat waiting", {
				thread_id: threadId,
				blocked: blocked.length,
			});
			return;
		}
		await postWithApproval(threadId, taken.body, []);
		await setStatus(threadId, taken.status);
		const title = (await titleOf(threadId)) ?? "仕事フォーラムの投稿";
		await deps.remember(
			taken.status === "完了"
				? `仕事フォーラムの「${title}」を終えた`
				: `仕事フォーラムの「${title}」を Mac に引き継いだ`,
		);
		await closeSeat(seat);
		log.info("seat done", { thread_id: threadId, status: taken.status });
	};

	const onEscalation = async (seat: Seat, msg: SeatMessage) => {
		const threadId = seat.threadId;
		if (msg.dispatchId !== seat.dispatchId) return;
		if (msg.stopReason !== null && seat.expectStop) {
			await deps.seats.set({ ...seat, expectStop: false });
			return;
		}
		if (msg.stopReason !== null && seat.status !== "working") return;
		expireGrant(threadId);
		const blocked = uniquePending(deps.ledger.takePending(threadId));
		if (seat.standup) {
			await deps.standupDone("", blocked);
			await closeSeat(seat);
			return;
		}
		// 止まった知らせの本文は端末の出力なので投稿に出さない
		await postWithApproval(
			threadId,
			msg.stopReason !== null ? STOPPED_TEXT : msg.body,
			blocked,
		);
		await deps.seats.set(toWaiting(seat, null));
		await setStatus(threadId, "決めてほしい");
		log.info("seat stopped", {
			thread_id: threadId,
			stop_reason: msg.stopReason,
			blocked: blocked.length,
		});
	};

	const startFromRequest = async (p: Payload) => {
		const summary = await deps.summarize(p.content);
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
		log.info("forum post created", {
			message_id: p.message_id,
			thread_id: threadId,
		});
		await deps.discord.send(
			p.channel_id,
			`フォーラムに立てました。続きはこちらで → ${messageLink(p.guild_id, threadId)}`,
			p.message_id,
		);
		await queue.run(threadId, async () => {
			// 投稿内の返事が先に届いていれば、その返事がやりとりを読ませて席を作っている
			if (deps.seats.get(threadId) !== null) return;
			await openSeat(
				newSeat(threadId),
				requestPrompt({
					now: now(),
					authorName: p.author.display_name,
					content: p.content,
					link,
				}),
			);
		});
	};

	const startFromForumPost = async (p: Payload) => {
		const threadId = p.channel_id;
		log.info("forum post received", { thread_id: threadId });
		await openSeat(
			newSeat(threadId),
			forumStarterPrompt({
				now: now(),
				authorName: p.author.display_name,
				title: await titleOf(threadId),
				content: p.content,
			}),
		);
	};

	/** 投稿内の返事。許可を待っている操作があれば、許可かどうかを先に見る。 */
	const answer = async (threadId: string, p: Payload) => {
		const reply = replyPrompt({
			now: now(),
			authorName: p.author.display_name,
			content: p.content,
		});
		const request = deps.approvals.get(threadId);
		if (request === null) {
			await deliver(threadId, reply, null);
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
			await deliver(threadId, reply, null);
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
		deps.ledger.grant(threadId, {
			grant_id: grantId,
			operations: [...request.operations],
		});
		log.info("approval granted", {
			thread_id: threadId,
			grant_id: grantId,
			operations: request.operations,
		});
		await deliver(
			threadId,
			approvedPrompt({
				now: now(),
				authorName: p.author.display_name,
				content: p.content,
				operations: request.operations,
			}),
			request.operations,
		);
	};

	const sleep = async (threadId: string) => {
		const seat = deps.seats.get(threadId);
		if (
			seat === null ||
			(seat.status !== "asking" && seat.status !== "waiting")
		)
			return;
		const stopped = await deps.orca.stopSeat(seat);
		if (!stopped.ok) {
			log.error("seat sleep failed", {
				thread_id: threadId,
				reason: stopped.error.reason,
			});
			return;
		}
		await deps.seats.set({
			...seat,
			status: "sleeping",
			terminal: null,
			questionId: null,
			expectStop: false,
		});
		log.info("seat sleeping", { thread_id: threadId });
		dequeue();
	};

	return {
		handle: async (envelope) => {
			const p = envelope.payload;
			if (p.author.id === deps.botUserId) return;
			// 持ち主以外の人やほかの bot の発言で席を動かさない
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
			if (p.message_id === threadId) {
				await queue.run(threadId, async () => {
					if (deps.seats.get(threadId) === null) await startFromForumPost(p);
				});
				return;
			}
			await queue.run(threadId, () => answer(threadId, p));
		},
		onSeatMessage: async (msg) => {
			const seat = msg.dispatchId
				? deps.seats.byDispatch(msg.dispatchId)
				: null;
			if (seat === null) {
				log.warn("seat message for unknown dispatch", {
					type: msg.type,
					dispatch_id: msg.dispatchId,
				});
				return;
			}
			await queue.run(seat.threadId, async () => {
				const current = deps.seats.get(seat.threadId);
				if (current === null) return;
				if (msg.type === "question") await onQuestion(current, msg);
				else if (msg.type === "worker_done") await onDone(current, msg);
				else if (msg.type === "escalation") await onEscalation(current, msg);
			});
		},
		startStandup: async (spec) => {
			const threadId = `standup-${randomUUID()}`;
			await queue.run(threadId, () => openSeat(newSeat(threadId, true), spec));
			return threadId;
		},
		sleepIdle: async () => {
			const limit = now().getTime() - deps.sleepAfterMs;
			const idle = deps.seats
				.all()
				.filter(
					(s) =>
						(s.status === "asking" || s.status === "waiting") &&
						!s.standup &&
						s.waitingSince !== null &&
						s.waitingSince.getTime() <= limit,
				);
			await Promise.all(
				idle.map((s) => queue.run(s.threadId, () => sleep(s.threadId))),
			);
		},
		reconcile: async () => {
			const [live, residue] = await Promise.all([
				deps.orca.liveTerminals(),
				deps.orca.residue(),
			]);
			if (!live.ok || !residue.ok) {
				log.error("seat reconcile failed", {
					reason: (!live.ok ? live.error : !residue.ok ? residue.error : null)
						?.reason,
				});
				return;
			}
			const seats = deps.seats.all();
			for (const seat of seats) {
				if (!ALIVE.has(seat.status)) continue;
				if (seat.terminal && live.value.has(seat.terminal)) continue;
				// 席の Claude はもういない。worktree と会話は残っているので、返事で起こす
				await deps.orca.stopSeat({
					dispatchId: seat.dispatchId,
					terminal: null,
				});
				if (seat.standup || seat.path === null) {
					await deps.seats.delete(seat.threadId);
					continue;
				}
				await deps.seats.set({
					...seat,
					status: "sleeping",
					terminal: null,
					questionId: null,
					expectStop: false,
				});
				if (seat.status === "working") {
					await deps.discord.send(seat.threadId, RESTARTED_TEXT);
					await setStatus(seat.threadId, "決めてほしい");
				}
				log.info("seat lost its claude", { thread_id: seat.threadId });
			}
			const known = new Map(
				deps.seats.all().flatMap((s) => (s.path ? [[s.path, s] as const] : [])),
			);
			for (const t of residue.value.terminals) {
				const owner = known.get(t.path);
				if (owner?.terminal === t.handle) continue;
				await deps.orca.closeTerminal(t.handle);
				log.info("stray seat terminal closed", { terminal: t.handle });
			}
			for (const path of residue.value.worktrees) {
				if (known.has(path)) continue;
				const r = await deps.orca.removeWorktree(path);
				log.info("stray seat worktree removed", { path, ok: r.ok });
			}
			dequeue();
		},
	};
};
