import { formatJstForPrompt, toModelJson } from "@yunomi/core";
import * as v from "valibot";
import { approvalRequestText, uniquePending } from "./approval.ts";
import type { ApprovalStore } from "./approval-store.ts";
import type { ClaudeRunner } from "./claude-cli.ts";
import type { DiscordApi } from "./discord-rest.ts";
import type { Ledger } from "./guard/ledger.ts";
import type { Logger } from "./logger.ts";
import {
	loginExpiryDecision,
	STANDUP_TITLE_LIMIT,
	standupPostFooter,
	standupPrompt,
} from "./prompts.ts";
import type { SessionStore } from "./session-store.ts";
import type { StandupMaterials } from "./standup-materials.ts";

export type Decision = { title: string; body: string };

const decisionsSchema = v.object({
	decisions: v.array(
		v.object({
			title: v.pipe(v.string(), v.trim(), v.nonEmpty()),
			body: v.pipe(v.string(), v.trim(), v.nonEmpty()),
		}),
	),
});

/** Claude の返事の最後の ```json ブロックから決めてほしいことを読む。読めなければ null。 */
export const parseDecisions = (text: string): Decision[] | null => {
	const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
	const last = blocks.at(-1)?.[1];
	if (last === undefined) return null;
	let json: unknown;
	try {
		json = JSON.parse(last);
	} catch {
		return null;
	}
	const parsed = v.safeParse(decisionsSchema, json);
	if (!parsed.success) return null;
	return parsed.output.decisions.map((d) => ({
		title:
			d.title.length > STANDUP_TITLE_LIMIT
				? `${d.title.slice(0, STANDUP_TITLE_LIMIT)}…`
				: d.title,
		body: d.body,
	}));
};

export type StandupDeps = {
	claude: ClaudeRunner;
	discord: DiscordApi;
	sessions: SessionStore;
	approvals: ApprovalStore;
	ledger: Ledger;
	workForumChannelId: string;
	gather: () => Promise<StandupMaterials>;
	newSessionId: () => string;
	now?: () => Date;
	logger: Logger;
};

export type StandupReport = {
	sessionId: string;
	decisions: number;
	posted: string[];
	failed: number;
};

const DECIDE_TAG = "決めてほしい";

/**
 * 朝会を 1 回する。Claude が材料を見て取り消せることを済ませ、決めてほしいことだけを返す。
 * 1 件ごとに仕事フォーラムへ投稿し、投稿は朝会のセッションから fork して返事で続けられるようにする。
 * 決めてほしいことが無ければ何も投稿しない。
 */
export const runStandup = async (deps: StandupDeps): Promise<StandupReport> => {
	const log = deps.logger;
	const now = (deps.now ?? (() => new Date()))();
	const sessionId = deps.newSessionId();
	// hook が止めた操作をこの朝会に紐づけて取り出すための ID。投稿ではない
	const guardThreadId = `standup-${sessionId}`;
	log.info("standup started", { session_id: sessionId });

	const materials = await deps.gather();
	const result = await deps.claude.run({
		prompt: standupPrompt({ now, materials: toModelJson(materials) }),
		session: { kind: "new", id: sessionId },
		guard: { threadId: guardThreadId, grants: [], grantId: null },
	});
	const blocked = uniquePending(deps.ledger.takePending(guardThreadId));
	if (!result.ok) {
		log.error("standup claude failed", {
			session_id: sessionId,
			error: result.error.type,
		});
	}
	const parsed = result.ok ? parseDecisions(result.value.text) : [];
	if (parsed === null) {
		log.error("standup decisions unreadable", { session_id: sessionId });
	}
	const decisions: Decision[] = [...(parsed ?? [])];
	if (
		materials.claude_login.expires_soon &&
		materials.claude_login.expires_at
	) {
		decisions.push(loginExpiryDecision(materials.claude_login.expires_at));
	}

	const report: StandupReport = {
		sessionId,
		decisions: decisions.length + (blocked.length > 0 ? 1 : 0),
		posted: [],
		failed: 0,
	};
	if (report.decisions === 0) {
		log.info("standup done", { ...report, session_id: sessionId });
		return report;
	}

	const forum = await deps.discord.getChannel(deps.workForumChannelId);
	const tagId = forum.ok
		? forum.value.availableTags.find((t) => t.name === DECIDE_TAG)?.id
		: undefined;
	if (!tagId) log.warn("forum tag missing", { tag: DECIDE_TAG });
	const day = formatJstForPrompt(now).slice(0, 10);

	const post = async (d: Decision) => {
		const created = await deps.discord.createForumPost(
			deps.workForumChannelId,
			{
				name: d.title,
				content: `${d.body}${standupPostFooter(day)}`,
				tagIds: tagId ? [tagId] : [],
			},
		);
		if (!created.ok) {
			report.failed++;
			log.error("standup post failed", {
				session_id: sessionId,
				error: created.error.type,
			});
			return null;
		}
		const { threadId } = created.value;
		if (result.ok) {
			await deps.sessions.set(threadId, result.value.sessionId, true);
		}
		report.posted.push(threadId);
		return threadId;
	};

	for (const d of decisions) await post(d);

	if (blocked.length > 0) {
		const threadId = await post({
			title: "朝会で止めた操作",
			body: approvalRequestText(blocked),
		});
		if (threadId !== null) {
			const operations = blocked.map((b) => b.operation);
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
	log.info("standup done", { ...report, session_id: sessionId });
	return report;
};
