import type { GatewayResponse, InboundMessage } from "@yunomi/protocol";
import type { TurnAuditData } from "../audit.ts";

export const RECENT_LIMIT = 30;
export const PROCESSED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type RecentMessage = {
	channelId: string;
	messageId: string;
	authorId: string;
	authorName: string;
	isBot: boolean;
	isPartner: boolean;
	content: string;
	occurredAt: string;
};

export type StoredResult = GatewayResponse & { audit: TurnAuditData };

type RecentRow = {
	channel_id: string;
	message_id: string;
	author_id: string;
	author_name: string;
	is_bot: number;
	is_partner: number;
	content: string;
	occurred_at: string;
};

const toRecent = (r: RecentRow): RecentMessage => ({
	channelId: r.channel_id,
	messageId: r.message_id,
	authorId: r.author_id,
	authorName: r.author_name,
	isBot: r.is_bot === 1,
	isPartner: r.is_partner === 1,
	content: r.content,
	occurredAt: r.occurred_at,
});

export class DoStore {
	readonly #sql: SqlStorage;

	constructor(sql: SqlStorage) {
		this.#sql = sql;
	}

	getProcessed(dedupeKey: string): StoredResult | null {
		const row = this.#sql
			.exec<{ response_json: string }>(
				"SELECT response_json FROM processed_events WHERE dedupe_key = ?",
				dedupeKey,
			)
			.toArray()[0];
		return row ? (JSON.parse(row.response_json) as StoredResult) : null;
	}

	putProcessed(dedupeKey: string, now: Date, result: StoredResult): void {
		this.#sql.exec(
			"INSERT OR REPLACE INTO processed_events (dedupe_key, processed_at, response_json) VALUES (?, ?, ?)",
			dedupeKey,
			now.toISOString(),
			JSON.stringify(result),
		);
		this.#sql.exec(
			"DELETE FROM processed_events WHERE processed_at < ?",
			new Date(now.getTime() - PROCESSED_TTL_MS).toISOString(),
		);
	}

	appendInbound(msg: InboundMessage): void {
		this.appendRecent({
			channelId: msg.channelId,
			messageId: msg.messageId,
			authorId: msg.author.id,
			authorName: msg.author.displayName,
			isBot: msg.author.isBot,
			isPartner: false,
			content: msg.content,
			occurredAt: msg.occurredAt.toISOString(),
		});
	}

	appendRecent(m: RecentMessage): void {
		this.#sql.exec(
			`INSERT OR IGNORE INTO recent_messages
				(channel_id, message_id, author_id, author_name, is_bot, is_partner, content, occurred_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			m.channelId,
			m.messageId,
			m.authorId,
			m.authorName,
			m.isBot ? 1 : 0,
			m.isPartner ? 1 : 0,
			m.content,
			m.occurredAt,
		);
		this.#sql.exec(
			`DELETE FROM recent_messages WHERE channel_id = ? AND rowid NOT IN (
				SELECT rowid FROM recent_messages WHERE channel_id = ? ORDER BY rowid DESC LIMIT ?
			)`,
			m.channelId,
			m.channelId,
			RECENT_LIMIT,
		);
	}

	/** 古い順。`beforeMessageId` を渡すと、その発言より前（挿入順）だけを返す。 */
	recentMessages(channelId: string, beforeMessageId?: string): RecentMessage[] {
		const rows = this.#sql
			.exec<RecentRow>(
				`SELECT * FROM recent_messages WHERE channel_id = ?
				AND (? IS NULL OR rowid < (SELECT rowid FROM recent_messages WHERE message_id = ?))
				ORDER BY rowid ASC`,
				channelId,
				beforeMessageId ?? null,
				beforeMessageId ?? null,
			)
			.toArray();
		return rows.map(toRecent);
	}

	getMessage(messageId: string): RecentMessage | null {
		const row = this.#sql
			.exec<RecentRow>(
				"SELECT * FROM recent_messages WHERE message_id = ?",
				messageId,
			)
			.toArray()[0];
		return row ? toRecent(row) : null;
	}

	lastPartnerReplyAt(channelId: string): Date | null {
		const row = this.#sql
			.exec<{ last_partner_reply_at: string | null }>(
				"SELECT last_partner_reply_at FROM channel_state WHERE channel_id = ?",
				channelId,
			)
			.toArray()[0];
		return row?.last_partner_reply_at
			? new Date(row.last_partner_reply_at)
			: null;
	}

	setLastPartnerReplyAt(channelId: string, at: Date): void {
		this.#sql.exec(
			`INSERT INTO channel_state (channel_id, last_partner_reply_at) VALUES (?, ?)
			ON CONFLICT (channel_id) DO UPDATE SET last_partner_reply_at = excluded.last_partner_reply_at`,
			channelId,
			at.toISOString(),
		);
	}
}
