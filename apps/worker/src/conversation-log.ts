import { newId } from "@yunomi/core";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { conversationMessages } from "./db/schema.ts";
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
