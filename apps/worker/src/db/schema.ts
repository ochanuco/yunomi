import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const partners = sqliteTable("partners", {
	id: text("id").primaryKey(),
	createdAt: text("created_at").notNull(),
});

export const entities = sqliteTable("entities", {
	id: text("id").primaryKey(),
	kind: text("kind").notNull(),
	displayName: text("display_name").notNull(),
	createdAt: text("created_at").notNull(),
});

export const externalIdentities = sqliteTable(
	"external_identities",
	{
		provider: text("provider").notNull(),
		externalId: text("external_id").notNull(),
		entityId: text("entity_id")
			.notNull()
			.references(() => entities.id),
	},
	(t) => [primaryKey({ columns: [t.provider, t.externalId] })],
);

export const stateTransitions = sqliteTable(
	"state_transitions",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		beforeJson: text("before_json").notNull(),
		afterJson: text("after_json").notNull(),
		deltaJson: text("delta_json").notNull(),
		reason: text("reason").notNull().default("turn_delta"),
		sourceEventId: text("source_event_id").notNull(),
		occurredAt: text("occurred_at").notNull(),
	},
	(t) => [index("state_transitions_partner").on(t.partnerId, t.occurredAt)],
);

export const relationshipEvents = sqliteTable(
	"relationship_events",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		entityId: text("entity_id")
			.notNull()
			.references(() => entities.id),
		type: text("type").notNull(),
		summary: text("summary").notNull(),
		familiarityDelta: real("familiarity_delta").notNull(),
		trustDelta: real("trust_delta").notNull(),
		closenessDelta: real("closeness_delta"),
		tensionDelta: real("tension_delta"),
		source: text("source").notNull(),
		confidence: real("confidence").notNull(),
		relatedEpisodeId: text("related_episode_id"),
		reason: text("reason").notNull(),
		occurredAt: text("occurred_at").notNull(),
	},
	(t) => [
		index("relationship_events_entity").on(
			t.partnerId,
			t.entityId,
			t.occurredAt,
		),
	],
);

export const facts = sqliteTable(
	"facts",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		subjectEntityId: text("subject_entity_id")
			.notNull()
			.references(() => entities.id),
		predicate: text("predicate").notNull(),
		objectType: text("object_type").notNull(),
		objectValue: text("object_value").notNull(),
		objectDisplay: text("object_display"),
		confidence: real("confidence").notNull(),
		importance: real("importance").notNull(),
		source: text("source").notNull(),
		observedAt: text("observed_at").notNull(),
		validFrom: text("valid_from").notNull(),
		validTo: text("valid_to"),
		decayPolicy: text("decay_policy").notNull().default("standard"),
		supersededBy: text("superseded_by"),
		/** 連想で Prompt に差し込んだ回数と最後の時刻。observed_at は書き換えない。 */
		recallCount: integer("recall_count").notNull().default(0),
		lastRecalledAt: text("last_recalled_at"),
		/** 持ち主が同じ話を再び出して observed_at を進めた回数。忘却曲線の定着を伸ばす。 */
		restateCount: integer("restate_count").notNull().default(0),
	},
	(t) => [
		index("facts_retrieval").on(
			t.partnerId,
			t.subjectEntityId,
			t.importance,
			t.observedAt,
		),
		// 現行 Fact は (subject, predicate) ごとに 1 件。並行ターンの二重 insert を防ぐ。
		uniqueIndex("facts_current_unique")
			.on(t.partnerId, t.subjectEntityId, t.predicate)
			.where(sql`${t.validTo} IS NULL AND ${t.supersededBy} IS NULL`),
	],
);

export const memoryCandidates = sqliteTable(
	"memory_candidates",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		// LLM の subject が話者を指さないときは entity を解決できないため null にし、subject_text に原文を残す。
		subjectEntityId: text("subject_entity_id").references(() => entities.id),
		subjectText: text("subject_text"),
		predicate: text("predicate").notNull(),
		objectType: text("object_type").notNull(),
		objectValue: text("object_value").notNull(),
		confidence: real("confidence").notNull(),
		importance: real("importance").notNull(),
		source: text("source").notNull(),
		status: text("status", {
			enum: ["pending", "promoted", "conflict", "rejected"],
		}).notNull(),
		conflictFactId: text("conflict_fact_id"),
		expiresAt: text("expires_at").notNull(),
		createdAt: text("created_at").notNull(),
		sourceEventId: text("source_event_id").notNull(),
	},
	(t) => [index("memory_candidates_status").on(t.partnerId, t.status)],
);

export const openLoops = sqliteTable(
	"open_loops",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		// 話し相手。prompt への注入と解決は、この entity の行だけを対象にする。
		entityId: text("entity_id")
			.notNull()
			.references(() => entities.id),
		channelId: text("channel_id").notNull(),
		summary: text("summary").notNull(),
		importance: real("importance").notNull(),
		dueAt: text("due_at"),
		dueConfidence: real("due_confidence"),
		// フォローアップ発話の実装まで使わない。
		followUpIntervalHours: real("follow_up_interval_hours"),
		status: text("status", { enum: ["open", "resolved", "dropped"] })
			.notNull()
			.default("open"),
		sourceMessageId: text("source_message_id").notNull(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
		resolvedAt: text("resolved_at"),
		lastFollowedUpAt: text("last_followed_up_at"),
	},
	(t) => [
		index("open_loops_entity_status").on(
			t.partnerId,
			t.entityId,
			t.status,
			t.importance,
		),
		index("open_loops_partner_created").on(t.partnerId, t.createdAt),
	],
);

export const auditEvents = sqliteTable(
	"audit_events",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		// inbound envelope の event_id。dedupe_key は再送を同一視するキー。
		eventId: text("event_id").notNull(),
		dedupeKey: text("dedupe_key").notNull(),
		channelId: text("channel_id").notNull(),
		authorEntityId: text("author_entity_id"),
		kind: text("kind", { enum: ["turn"] }).notNull(),
		decision: text("decision", { enum: ["reply", "ignore"] }).notNull(),
		reason: text("reason").notNull(),
		decisionSummary: text("decision_summary"),
		model: text("model"),
		fallbackUsed: integer("fallback_used", { mode: "boolean" }).notNull(),
		degraded: integer("degraded", { mode: "boolean" }).notNull(),
		errorType: text("error_type"),
		inputTokens: integer("input_tokens").notNull(),
		outputTokens: integer("output_tokens").notNull(),
		cacheReadTokens: integer("cache_read_tokens").notNull(),
		cacheWriteTokens: integer("cache_write_tokens").notNull(),
		latencyMs: integer("latency_ms").notNull(),
		// 受信本文。保持期間を過ぎたら行ごと削除する。
		inboundContent: text("inbound_content").notNull(),
		detailJson: text("detail_json").notNull(),
		occurredAt: text("occurred_at").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [index("audit_events_partner_created").on(t.partnerId, t.createdAt)],
);

// ゆかりさんが返事をしたターンの会話本文。持ち主と Partner の発言は無期限、それ以外は 90 日で消す。
export const conversationMessages = sqliteTable(
	"conversation_messages",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		channelId: text("channel_id").notNull(),
		// Discord の id か、DO が振った仮 ID（partner:...）。
		messageId: text("message_id").notNull(),
		discordMessageId: text("discord_message_id"),
		// 記録のきっかけになった受信 Envelope の event_id。
		turnEventId: text("turn_event_id").notNull(),
		authorId: text("author_id").notNull(),
		authorName: text("author_name").notNull(),
		isBot: integer("is_bot", { mode: "boolean" }).notNull(),
		isPartner: integer("is_partner", { mode: "boolean" }).notNull(),
		content: text("content").notNull(),
		occurredAt: text("occurred_at").notNull(),
		loggedAt: text("logged_at").notNull(),
	},
	(t) => [
		uniqueIndex("conversation_messages_key").on(
			t.partnerId,
			t.channelId,
			t.messageId,
		),
		index("conversation_messages_channel_time").on(
			t.partnerId,
			t.channelId,
			t.occurredAt,
		),
	],
);

// 会話ログの削除など、記憶を消した操作の記録。消した本文や条件は持たず、件数だけを残す。保持は無期限。
export const maintenanceEvents = sqliteTable(
	"maintenance_events",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		kind: text("kind", {
			enum: ["conversation_log_delete", "conversation_log_retention"],
		}).notNull(),
		actor: text("actor", { enum: ["owner", "ykm", "cron"] }).notNull(),
		deletedCount: integer("deleted_count").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		index("maintenance_events_partner_created").on(t.partnerId, t.createdAt),
	],
);

// audit_events は 30 日で消えるため、削除前に生活日単位へ集計して長期保存する。
export const auditDailyKpis = sqliteTable(
	"audit_daily_kpis",
	{
		partnerId: text("partner_id").notNull(),
		// 生活日（JST 05:00 境界）の YYYY-MM-DD。
		day: text("day").notNull(),
		turns: integer("turns").notNull(),
		replies: integer("replies").notNull(),
		ignores: integer("ignores").notNull(),
		// error_type を持つターン。成功率は 1 - errors / turns。
		errors: integer("errors").notNull(),
		degraded: integer("degraded").notNull(),
		fallbackUsed: integer("fallback_used").notNull(),
		// reply ターンの latency。reply が無い日は null。
		latencyP50Ms: integer("latency_p50_ms"),
		latencyP95Ms: integer("latency_p95_ms"),
		inputTokens: integer("input_tokens").notNull(),
		outputTokens: integer("output_tokens").notNull(),
		cacheReadTokens: integer("cache_read_tokens").notNull(),
		cacheWriteTokens: integer("cache_write_tokens").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.partnerId, t.day] })],
);

// 行が無い topic はプロファイルの初期値として扱い、初回の変化で行を作る。
export const interestStates = sqliteTable(
	"interest_states",
	{
		partnerId: text("partner_id").notNull(),
		topic: text("topic").notNull(),
		score: real("score").notNull(),
		baseline: real("baseline").notNull(),
		learnedDelta: real("learned_delta").notNull(),
		summary: text("summary").notNull(),
		updatedAt: text("updated_at").notNull(),
		source: text("source", { enum: ["profile", "learned"] }).notNull(),
	},
	(t) => [primaryKey({ columns: [t.partnerId, t.topic] })],
);

export const opinionStates = sqliteTable(
	"opinion_states",
	{
		partnerId: text("partner_id").notNull(),
		topic: text("topic").notNull(),
		stance: text("stance").notNull(),
		confidence: real("confidence").notNull(),
		stability: real("stability").notNull(),
		// JSON 配列（string[]）。
		reasons: text("reasons").notNull(),
		sourceMemoryIds: text("source_memory_ids").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.partnerId, t.topic] })],
);

export const interestChanges = sqliteTable(
	"interest_changes",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		topic: text("topic").notNull(),
		beforeScore: real("before_score").notNull(),
		afterScore: real("after_score").notNull(),
		reason: text("reason").notNull(),
		sourceMessageId: text("source_message_id").notNull(),
		// 生活日（JST 05:00 境界）の YYYY-MM-DD。日次上限の集計に使う。
		lifestyleDay: text("lifestyle_day").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		index("interest_changes_day").on(t.partnerId, t.lifestyleDay, t.topic),
	],
);

export const opinionChanges = sqliteTable(
	"opinion_changes",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		topic: text("topic").notNull(),
		direction: text("direction", {
			enum: ["strengthen", "weaken", "shift"],
		}).notNull(),
		beforeStance: text("before_stance").notNull(),
		afterStance: text("after_stance").notNull(),
		beforeConfidence: real("before_confidence").notNull(),
		afterConfidence: real("after_confidence").notNull(),
		reason: text("reason").notNull(),
		sourceMessageId: text("source_message_id").notNull(),
		lifestyleDay: text("lifestyle_day").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(t) => [
		index("opinion_changes_day").on(t.partnerId, t.lifestyleDay, t.topic),
	],
);

// Working（仕事）の Yukarin が残す、決まったこと・終わったことの1行。
// facts は (subject, predicate) ごとに現行1件なので、同じ種類の行を何件も持てるよう別の表にする。
export const workNotes = sqliteTable(
	"work_notes",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		entityId: text("entity_id")
			.notNull()
			.references(() => entities.id),
		kind: text("kind", { enum: ["decided", "done", "goal"] }).notNull(),
		summary: text("summary").notNull(),
		createdAt: text("created_at").notNull(),
		/** goal だけが持つ。decided と done は null。 */
		status: text("status", { enum: ["open", "achieved", "dropped"] }),
		closedAt: text("closed_at"),
		/** 連想で Prompt に差し込んだ回数と最後の時刻。created_at は書き換えない。 */
		recallCount: integer("recall_count").notNull().default(0),
		lastRecalledAt: text("last_recalled_at"),
	},
	(t) => [index("work_notes_entity").on(t.partnerId, t.entityId, t.createdAt)],
);

/** 見張り。Working の見回りが、時間が来たものだけを調べて新着を知らせる。 */
export const watches = sqliteTable(
	"watches",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		entityId: text("entity_id")
			.notNull()
			.references(() => entities.id),
		/** 何を探すか（条件を含む 1 行）。 */
		query: text("query").notNull(),
		/** どこを見るか。店の名前か URL の JSON 配列。空なら普通の検索。 */
		sources: text("sources").notNull(),
		/** 何分おきに調べるか。schedule の見張りでは null。 */
		intervalMinutes: integer("interval_minutes"),
		/** 調べる時刻の cron 式（5 項目、日本時間で読む）。間隔の見張りでは null。 */
		schedule: text("schedule"),
		untilAt: text("until_at"),
		status: text("status", { enum: ["active", "stopped"] }).notNull(),
		/** 前に知らせたものの key の JSON 配列。新しいものを後ろに足す。 */
		seen: text("seen").notNull(),
		lastCheckedAt: text("last_checked_at"),
		createdAt: text("created_at").notNull(),
		stoppedAt: text("stopped_at"),
		/** 新着を書く仕事フォーラムの投稿。席が登録した見張りだけが持ち、無ければ仕事チャンネルに書く。 */
		notifyThreadId: text("notify_thread_id"),
	},
	(t) => [index("watches_entity").on(t.partnerId, t.entityId, t.status)],
);

/**
 * conversation_messages を索引に入れる単位。持ち主の発言 1 件（anchor）に、その直前の持ち主と Partner の発言と、
 * 続く Partner の返事をまとめる。id は anchor の conversation_messages.id。
 */
export const conversationChunks = sqliteTable(
	"conversation_chunks",
	{
		id: text("id").primaryKey(),
		partnerId: text("partner_id").notNull(),
		channelId: text("channel_id").notNull(),
		body: text("body").notNull(),
		startedAt: text("started_at").notNull(),
		/** anchor の発言時刻。期間で絞るときの基準。 */
		occurredAt: text("occurred_at").notNull(),
		endedAt: text("ended_at").notNull(),
		/** 連想で Prompt に差し込んだ回数と最後の時刻。occurred_at は書き換えない。 */
		recallCount: integer("recall_count").notNull().default(0),
		lastRecalledAt: text("last_recalled_at"),
	},
	(t) => [
		index("conversation_chunks_channel_time").on(
			t.partnerId,
			t.channelId,
			t.occurredAt,
		),
	],
);

/** 塊がどの発言から作られたか。会話ログを消すとき、影響する塊を引くのに使う。 */
export const conversationChunkMessages = sqliteTable(
	"conversation_chunk_messages",
	{
		chunkId: text("chunk_id").notNull(),
		messageId: text("message_id").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.chunkId, t.messageId] }),
		index("conversation_chunk_messages_message").on(t.messageId),
	],
);

/**
 * キーワード検索（FTS5）の文書。facts・work_notes・conversation_chunks の trigger が書き、
 * memory_search_fts が trigger でこの表に追従する（migration 0017）。アプリからは書かない。
 * Vectorize の同期もこの表を正として行う。
 */
export const memorySearchDocs = sqliteTable(
	"memory_search_docs",
	{
		// FTS5 の external content は整数の rowid で結び付くため、整数の主キーを持たせる。
		id: integer("id").primaryKey({ autoIncrement: true }),
		kind: text("kind", {
			enum: ["fact", "work_note", "conversation"],
		}).notNull(),
		sourceId: text("source_id").notNull(),
		partnerId: text("partner_id").notNull(),
		body: text("body").notNull(),
		/** facts は observed_at、work_notes は created_at、塊は anchor の occurred_at。 */
		at: text("at").notNull(),
	},
	(t) => [
		uniqueIndex("memory_search_docs_source").on(t.kind, t.sourceId),
		index("memory_search_docs_partner").on(t.partnerId, t.id),
	],
);
