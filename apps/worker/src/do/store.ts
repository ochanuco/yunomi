import type {
	DailyAccumulator,
	PartnerState,
	Presence,
	Relationship,
} from "@yunomi/core";
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

	getState(): PartnerState | null {
		const r = this.#sql
			.exec<{
				mood: number;
				energy: number;
				presence: string;
				system_stress: number;
				degraded_mode: number;
				version: number;
				updated_at: string;
			}>("SELECT * FROM partner_state WHERE id = 1")
			.toArray()[0];
		return r
			? {
					mood: r.mood,
					energy: r.energy,
					presence: r.presence as Presence,
					systemStress: r.system_stress,
					degradedMode: r.degraded_mode === 1,
					version: r.version,
					updatedAt: r.updated_at,
				}
			: null;
	}

	putState(s: PartnerState): void {
		this.#sql.exec(
			`INSERT OR REPLACE INTO partner_state
				(id, mood, energy, presence, system_stress, degraded_mode, version, updated_at)
			VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
			s.mood,
			s.energy,
			s.presence,
			s.systemStress,
			s.degradedMode ? 1 : 0,
			s.version,
			s.updatedAt,
		);
	}

	getRelationship(
		partnerId: string,
		entityId: string,
	): { relationship: Relationship; accumulator: DailyAccumulator } | null {
		const r = this.#sql
			.exec<{
				familiarity: number;
				trust: number;
				summary: string | null;
				version: number;
				updated_at: string;
				acc_day: string;
				acc_familiarity: number;
				acc_trust: number;
			}>("SELECT * FROM relationships WHERE entity_id = ?", entityId)
			.toArray()[0];
		return r
			? {
					relationship: {
						partnerId,
						entityId,
						familiarity: r.familiarity,
						trust: r.trust,
						summary: r.summary,
						version: r.version,
						updatedAt: r.updated_at,
					},
					accumulator: {
						day: r.acc_day,
						familiarity: r.acc_familiarity,
						trust: r.acc_trust,
					},
				}
			: null;
	}

	listRelationships(partnerId: string): Relationship[] {
		return this.#sql
			.exec<{
				entity_id: string;
				familiarity: number;
				trust: number;
				summary: string | null;
				version: number;
				updated_at: string;
			}>(
				"SELECT entity_id, familiarity, trust, summary, version, updated_at FROM relationships ORDER BY updated_at DESC, entity_id",
			)
			.toArray()
			.map((r) => ({
				partnerId,
				entityId: r.entity_id,
				familiarity: r.familiarity,
				trust: r.trust,
				summary: r.summary,
				version: r.version,
				updatedAt: r.updated_at,
			}));
	}

	putRelationship(rel: Relationship, acc: DailyAccumulator): void {
		this.#sql.exec(
			`INSERT OR REPLACE INTO relationships
				(entity_id, familiarity, trust, summary, version, updated_at, acc_day, acc_familiarity, acc_trust)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			rel.entityId,
			rel.familiarity,
			rel.trust,
			rel.summary,
			rel.version,
			rel.updatedAt,
			acc.day,
			acc.familiarity,
			acc.trust,
		);
	}

	cachedEntity(provider: string, externalId: string): string | null {
		return (
			this.#sql
				.exec<{ entity_id: string }>(
					"SELECT entity_id FROM entity_cache WHERE provider = ? AND external_id = ?",
					provider,
					externalId,
				)
				.toArray()[0]?.entity_id ?? null
		);
	}

	cacheEntity(provider: string, externalId: string, entityId: string): void {
		this.#sql.exec(
			"INSERT OR REPLACE INTO entity_cache (provider, external_id, entity_id) VALUES (?, ?, ?)",
			provider,
			externalId,
			entityId,
		);
	}
}
