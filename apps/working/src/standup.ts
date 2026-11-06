import { formatJstForPrompt, toModelJson } from "@yunomi/core";
import * as v from "valibot";
import type { ActivityEntry } from "./activity-log.ts";
import { APPROVAL_BUTTONS, approvalRequestText } from "./approval.ts";
import type { ApprovalStore } from "./approval-store.ts";
import type { DiscordApi } from "./discord-rest.ts";
import type { Ledger, Pending } from "./guard/ledger.ts";
import type { Logger } from "./logger.ts";
import { diffPatrol, type PatrolStore, patrolSources } from "./patrol.ts";
import {
	loginExpiryDecision,
	patrolPrompt,
	STANDUP_TITLE_LIMIT,
	seatSpec,
	standupPostFooter,
	standupPrompt,
} from "./prompts.ts";
import {
	failed,
	memoryForSeat,
	type StandupMaterials,
	type Watch,
} from "./standup-materials.ts";
import type { RunKind } from "./standup-timer.ts";

export type Decision = { title: string; body: string };

const reportSchema = v.object({
	decisions: v.array(
		v.object({
			title: v.pipe(v.string(), v.trim(), v.nonEmpty()),
			body: v.pipe(v.string(), v.trim(), v.nonEmpty()),
		}),
	),
	notices: v.optional(
		v.array(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.regex(/^[^\r\n]*$/))),
		[],
	),
});

export type SeatReport = { decisions: Decision[]; notices: string[] };

/** Claude の返事の最後の ```json ブロックから、決めてほしいことと見張りの知らせを読む。読めなければ null。 */
export const parseReport = (text: string): SeatReport | null => {
	const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
	const last = blocks.at(-1)?.[1];
	if (last === undefined) return null;
	let json: unknown;
	try {
		json = JSON.parse(last);
	} catch {
		return null;
	}
	const parsed = v.safeParse(reportSchema, json);
	if (!parsed.success) return null;
	return {
		decisions: parsed.output.decisions.map((d) => ({
			title:
				d.title.length > STANDUP_TITLE_LIMIT
					? `${d.title.slice(0, STANDUP_TITLE_LIMIT)}…`
					: d.title,
			body: d.body,
		})),
		notices: parsed.output.notices,
	};
};

/** 決めてほしいことだけを読む。 */
export const parseDecisions = (text: string): Decision[] | null =>
	parseReport(text)?.decisions ?? null;

export type StandupDeps = {
	discord: DiscordApi;
	approvals: ApprovalStore;
	ledger: Ledger;
	workForumChannelId: string;
	/** 見張りの知らせを書くチャンネル。 */
	workTextChannelId: string;
	/** 朝会・見回り・GitHub の知らせの席が止められた操作を、活動ログに 1 行残す。 */
	recordActivity?: (entry: ActivityEntry) => Promise<void>;
	now?: () => Date;
	logger: Logger;
};

const DECIDE_TAG = "決めてほしい";

export type StandupReport = { posted: string[]; failed: number };

const RUN_NAME: Record<RunKind, string> = {
	standup: "朝会",
	patrol: "見回り",
	event: "GitHub の知らせ",
};

/** 投稿の最後に足す「どの回から」。朝会は日付、見回りは時刻で見分ける。 */
const runLabel = (kind: RunKind, now: Date) => {
	const jst = formatJstForPrompt(now);
	return `${kind === "standup" ? jst.slice(0, 10) : jst.slice(11, 16)} の${RUN_NAME[kind]}`;
};

/** 決めてほしいこと 1 件ごとに仕事フォーラムへ投稿する。投稿への返事は、その投稿の新しい席が受ける。 */
export const postDecisions = async (
	deps: StandupDeps,
	decisions: readonly Decision[],
	blocked: readonly Pending[],
	kind: RunKind = "standup",
): Promise<StandupReport> => {
	const log = deps.logger;
	const now = (deps.now ?? (() => new Date()))();
	const report: StandupReport = { posted: [], failed: 0 };
	if (decisions.length === 0 && blocked.length === 0) return report;

	const forum = await deps.discord.getChannel(deps.workForumChannelId);
	const tagId = forum.ok
		? forum.value.availableTags.find((t) => t.name === DECIDE_TAG)?.id
		: undefined;
	if (!tagId) log.warn("forum tag missing", { tag: DECIDE_TAG });
	const from = runLabel(kind, now);

	const post = async (d: Decision, buttons?: typeof APPROVAL_BUTTONS) => {
		const created = await deps.discord.createForumPost(
			deps.workForumChannelId,
			{
				name: d.title,
				content: `${d.body}${standupPostFooter(from)}`,
				tagIds: tagId ? [tagId] : [],
				buttons,
			},
		);
		if (!created.ok) {
			report.failed++;
			log.error("standup post failed", { error: created.error.type });
			return null;
		}
		report.posted.push(created.value.threadId);
		return created.value.threadId;
	};

	for (const d of decisions) await post(d);

	if (blocked.length > 0) {
		const title = `${RUN_NAME[kind]}で止めた操作`;
		const threadId = await post(
			{ title, body: approvalRequestText(blocked) },
			APPROVAL_BUTTONS,
		);
		if (threadId !== null) {
			const operations = blocked.map((b) => b.operation);
			await deps
				.recordActivity?.({
					at: now,
					kind: "blocked",
					threadId,
					title,
					partner: "yukarin",
					tools: operations.map((o) => o.tool),
				})
				.catch((e: unknown) =>
					log.warn("activity record failed", { error: String(e) }),
				);
			// フォーラム投稿の最初のメッセージは投稿と同じ ID を持つ
			await deps.approvals.set(threadId, {
				messageIds: [threadId],
				operations,
			});
			deps.ledger.log({
				event: "requested",
				thread_id: threadId,
				message_id: threadId,
				operations,
			});
		}
	}
	return report;
};

/** 時間が来た見張り。記憶を読めなかった回は 0 件として、次の回に回す。 */
export const dueWatches = (m: StandupMaterials): Watch[] =>
	failed(m.watches) ? [] : m.watches.filter((w) => w.due);

/**
 * 朝会か見回りを始める。材料を集めて席に渡す。席は取り消せることを済ませ、決めてほしいことを worker_done で返す。
 * 見回りは前の回から変わった件と時間が来た見張りだけを渡し、どちらも無ければ席を立てない（トークン代を使わない）。
 * ログインの期限は Claude の返事によらないので、朝会のときにここで先に投稿する。
 * 席を立てたら席の ID、立てなかったら null を返す。
 */
export const startStandup = async (input: {
	deps: StandupDeps;
	kind: RunKind;
	gather: () => Promise<StandupMaterials>;
	store: PatrolStore;
	preamble: string;
	start: (spec: string, kind: RunKind) => Promise<string>;
}): Promise<string | null> => {
	const { deps, kind } = input;
	const log = deps.logger;
	const now = (deps.now ?? (() => new Date()))();
	const materials = await input.gather();
	const prev = await input.store.load();
	const { changes, next } = diffPatrol(prev ?? {}, patrolSources(materials));

	const watches = dueWatches(materials);

	if (kind === "patrol") {
		// 初めての回は前の回が無く、全部が新着に見える。朝会で見る分を二度投稿しないよう、覚えるだけにする
		const seen = prev === null ? {} : changes;
		if (Object.keys(seen).length === 0 && watches.length === 0) {
			await input.store.save(next);
			log.info("patrol quiet", { first: prev === null });
			return null;
		}
		const id = await input.start(
			seatSpec(
				input.preamble,
				patrolPrompt({
					now,
					materials: toModelJson({
						changes: seen,
						due_watches: watches,
						memory: memoryForSeat(materials.memory),
						mac_state: materials.mac_state,
					}),
				}),
			),
			kind,
		);
		await input.store.save(next);
		log.info("patrol started", {
			seat: id,
			changes: Object.fromEntries(
				Object.entries(seen).map(([k, xs]) => [k, xs.length]),
			),
			watches: watches.length,
		});
		return id;
	}

	if (
		materials.claude_login.expires_soon &&
		materials.claude_login.expires_at
	) {
		await postDecisions(
			deps,
			[loginExpiryDecision(materials.claude_login.expires_at)],
			[],
		);
	}
	const id = await input.start(
		seatSpec(
			input.preamble,
			standupPrompt({
				now,
				materials: toModelJson({
					...materials,
					memory: memoryForSeat(materials.memory),
					watches: undefined,
					due_watches: watches,
				}),
			}),
		),
		kind,
	);
	await input.store.save(next);
	log.info("standup started", { seat: id });
	return id;
};

/** 見張りの新着を仕事チャンネルに 1 件 1 行で書く。無ければ何も書かない。 */
export const postNotices = async (
	deps: StandupDeps,
	notices: readonly string[],
): Promise<boolean> => {
	if (notices.length === 0) return true;
	const sent = await deps.discord.send(
		deps.workTextChannelId,
		notices.join("\n"),
	);
	if (!sent.ok) {
		deps.logger.error("watch notice failed", { error: sent.error.type });
		return false;
	}
	return true;
};

/** 朝会か見回りの席の報告を読み、決めてほしいことを投稿にし、見張りの新着を知らせる。 */
export const finishStandup = async (
	deps: StandupDeps,
	text: string,
	blocked: readonly Pending[],
	kind: RunKind = "standup",
): Promise<StandupReport> => {
	const parsed = parseReport(text);
	if (parsed === null) {
		deps.logger.error("standup decisions unreadable", {});
	}
	const notified = await postNotices(deps, parsed?.notices ?? []);
	const report = await postDecisions(
		deps,
		parsed?.decisions ?? [],
		blocked,
		kind,
	);
	deps.logger.info("standup done", {
		kind,
		decisions: (parsed?.decisions ?? []).length,
		notices: (parsed?.notices ?? []).length,
		notices_failed: !notified,
		blocked: blocked.length,
		...report,
	});
	return report;
};
