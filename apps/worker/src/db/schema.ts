import {
	index,
	primaryKey,
	real,
	sqliteTable,
	text,
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
