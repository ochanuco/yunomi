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
