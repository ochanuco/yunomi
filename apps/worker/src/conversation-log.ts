import { CONVERSATION_LOG_DELETE_MAX_MESSAGE_IDS } from "@yunomi/admin-contract";
import { err, newId, ok, type Result } from "@yunomi/core";
import { and, eq, gte, inArray, lt, ne, or, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { conversationMessages, maintenanceEvents } from "./db/schema.ts";
import type { RecentMessage } from "./do/store.ts";

/** 受信メッセージより前から、文脈として一緒に残す件数。 */
export const CONTEXT_BEFORE_COUNT = 10;

export type LoggedMessage = RecentMessage & {
	/** Worker が送った partner 発言の Discord 上の id。分からなければ省く。 */
	discordMessageId?: string | null;
};

export type ConversationLogContext = {
	partnerId: string;
	/** 返事をしたターンの受信 Envelope の event_id。 */
	turnEventId: string;
	now: Date;
};

export type ConversationLogWriter = {
	record(
		ctx: ConversationLogContext,
		messages: readonly LoggedMessage[],
	): Promise<void>;
};

export const toConversationRow = (
	ctx: ConversationLogContext,
	m: LoggedMessage,
): typeof conversationMessages.$inferInsert => ({
	id: newId(),
	partnerId: ctx.partnerId,
	channelId: m.channelId,
	messageId: m.messageId,
	discordMessageId: m.discordMessageId ?? null,
	turnEventId: ctx.turnEventId,
	authorId: m.authorId,
	authorName: m.authorName,
	isBot: m.isBot,
	isPartner: m.isPartner,
	content: m.content,
	occurredAt: m.occurredAt,
	loggedAt: ctx.now.toISOString(),
});

export const createConversationLogWriter = (
	db: DrizzleD1Database,
): ConversationLogWriter => ({
	async record(ctx, messages) {
		if (messages.length === 0) return;
		// D1 は 1 文あたりの束縛変数が 100 個までなので、1 行ずつ batch で送る。
		// 文脈は返事のたびに重なって拾われるため、既にある行は無視する。
		const [first, ...rest] = messages.map((m) =>
			db
				.insert(conversationMessages)
				.values(toConversationRow(ctx, m))
				.onConflictDoNothing(),
		);
		if (first) await db.batch([first, ...rest]);
	},
});

/** 持ち主と Partner 以外の発言を残す日数。 */
export const CONVERSATION_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// ID は message_id と discord_message_id の両方に束縛するため、D1 の 1 文あたりの上限 100 個に
// ほかの条件と合わせて収まる数に抑える。
const MAX_DELETE_MESSAGE_IDS = CONVERSATION_LOG_DELETE_MAX_MESSAGE_IDS;

/**
 * 消す行の条件。指定した条件はすべて満たす行だけを消す。
 * from / to は occurred_at（UTC の ISO 8601）で、from は含み to は含まない。
 */
export type ConversationLogCriteria = {
	partnerId: string;
	from?: string;
	to?: string;
	channelId?: string;
	/** message_id か discord_message_id のどちらかが一致する行。 */
	messageIds?: readonly string[];
	/** この author の発言は消さない。 */
	keepAuthorIds?: readonly string[];
	/** Partner 自身の発言（is_partner）を消さない。 */
	keepPartner?: boolean;
};

export type ConversationLogDeleteError =
	| { type: "empty_criteria" }
	| { type: "too_many_message_ids"; max: number };

const toWhere = (c: ConversationLogCriteria): SQL | undefined => {
	const m = conversationMessages;
	const ids = c.messageIds;
	return and(
		eq(m.partnerId, c.partnerId),
		c.from === undefined ? undefined : gte(m.occurredAt, c.from),
		c.to === undefined ? undefined : lt(m.occurredAt, c.to),
		c.channelId === undefined ? undefined : eq(m.channelId, c.channelId),
		ids === undefined
			? undefined
			: or(
					inArray(m.messageId, [...ids]),
					inArray(m.discordMessageId, [...ids]),
				),
		...(c.keepAuthorIds ?? []).map((id) => ne(m.authorId, id)),
		c.keepPartner ? eq(m.isPartner, false) : undefined,
	);
};

/**
 * 会話ログの行を消す唯一の入口。消した（dryRun では消す対象の）行の id を返す。
 * 索引など、会話ログから作ったものを後で追従させるときは、返した id を使う。
 */
export const deleteConversationMessages = async (
	db: DrizzleD1Database,
	criteria: ConversationLogCriteria,
	opts: { dryRun: boolean },
): Promise<Result<{ ids: string[] }, ConversationLogDeleteError>> => {
	const { from, to, channelId, messageIds } = criteria;
	// partner の会話ログを丸ごと消す指定は受けない。
	if (
		from === undefined &&
		to === undefined &&
		channelId === undefined &&
		messageIds === undefined
	) {
		return err({ type: "empty_criteria" });
	}
	if (messageIds !== undefined && messageIds.length === 0) {
		return err({ type: "empty_criteria" });
	}
	if (messageIds !== undefined && messageIds.length > MAX_DELETE_MESSAGE_IDS) {
		return err({ type: "too_many_message_ids", max: MAX_DELETE_MESSAGE_IDS });
	}
	const where = toWhere(criteria);
	const rows = opts.dryRun
		? await db
				.select({ id: conversationMessages.id })
				.from(conversationMessages)
				.where(where)
		: await db
				.delete(conversationMessages)
				.where(where)
				.returning({ id: conversationMessages.id });
	return ok({ ids: rows.map((r) => r.id) });
};

export type MaintenanceActor = (typeof maintenanceEvents.$inferInsert)["actor"];
export type MaintenanceKind = (typeof maintenanceEvents.$inferInsert)["kind"];

export const recordMaintenance = async (
	db: DrizzleD1Database,
	e: {
		partnerId: string;
		kind: MaintenanceKind;
		actor: MaintenanceActor;
		deletedCount: number;
		now: Date;
	},
): Promise<void> => {
	await db.insert(maintenanceEvents).values({
		id: newId(),
		partnerId: e.partnerId,
		kind: e.kind,
		actor: e.actor,
		deletedCount: e.deletedCount,
		createdAt: e.now.toISOString(),
	});
};

/** この時刻より前の発言は、持ち主と Partner のもの以外を消す。 */
export const conversationRetentionCutoff = (now: Date): Date =>
	new Date(now.getTime() - CONVERSATION_RETENTION_DAYS * DAY_MS);

/** 日次 cron の保持期間切れ削除。持ち主と Partner の発言は残す。消した件数を返す。 */
export const purgeExpiredConversationMessages = async (
	db: DrizzleD1Database,
	partnerId: string,
	ownerDiscordUserId: string,
	now: Date,
): Promise<number> => {
	const r = await deleteConversationMessages(
		db,
		{
			partnerId,
			to: conversationRetentionCutoff(now).toISOString(),
			keepAuthorIds: [ownerDiscordUserId],
			keepPartner: true,
		},
		{ dryRun: false },
	);
	if (!r.ok) throw new Error(`conversation log retention: ${r.error.type}`);
	const count = r.value.ids.length;
	if (count > 0) {
		await recordMaintenance(db, {
			partnerId,
			kind: "conversation_log_retention",
			actor: "cron",
			deletedCount: count,
			now,
		});
	}
	return count;
};
