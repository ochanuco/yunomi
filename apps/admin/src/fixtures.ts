import type {
	AuditItem,
	CandidateView,
	FactView,
	RelationshipView,
	StatusResponse,
} from "@yunomi/admin-contract";

export const status: StatusResponse = {
	partner_id: "yukarin",
	env: "development",
	profile_version: 1,
	state: {
		mood: 0.3,
		energy: 0.5,
		presence: "available",
		system_stress: 0,
		degraded_mode: false,
		version: 4,
		updated_at: "2026-10-11T03:00:00.000Z",
	},
	counts: { facts: 3, pending_candidates: 1 },
	last_audit_at: "2026-10-11T03:00:01.000Z",
};

export const relationship: RelationshipView = {
	entity_id: "e1",
	display_name: "alice",
	familiarity: 0.12,
	trust: 0.32,
	summary: null,
	version: 2,
	updated_at: "2026-10-11T03:00:00.000Z",
};

export const fact: FactView = {
	id: "f1",
	subject_entity_id: "e1",
	predicate: "好きな飲み物",
	object_type: "string",
	object_value: "緑茶",
	object_display: null,
	confidence: 0.9,
	importance: 0.7,
	source: "user_statement",
	observed_at: "2026-10-11T03:00:00.000Z",
	valid_from: "2026-10-11T03:00:00.000Z",
	valid_to: null,
	superseded_by: null,
};

export const candidate: CandidateView = {
	id: "c1",
	subject_entity_id: null,
	subject_text: "友達",
	predicate: "誕生日",
	object_type: "string",
	object_value: "5月",
	confidence: 0.5,
	importance: 0.5,
	source: "inferred",
	status: "pending",
	conflict_fact_id: null,
	expires_at: "2026-11-11T03:00:00.000Z",
	created_at: "2026-10-11T03:00:00.000Z",
	source_event_id: "ev",
};

export const auditItem = (over: Partial<AuditItem> = {}): AuditItem => ({
	id: "a1",
	event_id: "e1",
	dedupe_key: "k1",
	channel_id: "c",
	author_entity_id: null,
	kind: "turn",
	decision: "reply",
	reason: "llm",
	decision_summary: "挨拶された",
	model: "claude-haiku-4-5",
	fallback_used: false,
	degraded: false,
	error_type: null,
	usage: {
		input_tokens: 100,
		output_tokens: 20,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
	},
	latency_ms: 812,
	inbound_content: "ゆかりん、おはよう",
	detail: { toolCalls: [] },
	occurred_at: "2026-10-11T03:00:00.000Z",
	created_at: "2026-10-11T03:00:01.000Z",
	...over,
});
