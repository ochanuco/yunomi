import type {
	AuditItem,
	CandidateView,
	FactView,
	InterestView,
	KpiDay,
	OpenLoopView,
	OpinionView,
	RelationshipView,
	Snapshot,
	StateHistoryResponse,
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

export const openLoop: OpenLoopView = {
	id: "ol1",
	entity_id: "e1",
	entity_display_name: "alice",
	channel_id: "c",
	summary: "明日の面接の結果",
	importance: 0.7,
	due_at: "2026-10-11T15:30:00.000Z",
	due_confidence: 0.6,
	follow_up_interval_hours: null,
	status: "open",
	source_message_id: "m1",
	created_at: "2026-10-11T03:00:00.000Z",
	updated_at: "2026-10-11T03:00:00.000Z",
	resolved_at: null,
	last_followed_up_at: null,
};

export const interest: InterestView = {
	topic: "music-voice",
	label: "音楽と声",
	score: 0.73,
	baseline: 0.7,
	learned_delta: 0.03,
	summary: "歌や声の表現に耳が向く。",
	updated_at: "2026-10-11T03:00:00.000Z",
	source: "learned",
};

export const opinion: OpinionView = {
	topic: "honesty",
	label: "分からないことの扱い",
	stance: "知らないことは知らないと言うほうがよい。",
	confidence: 0.8,
	stability: 0.85,
	reasons: [],
	source_memory_ids: [],
	updated_at: null,
	source: "profile",
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
	detail: {},
	occurred_at: "2026-10-11T03:00:00.000Z",
	created_at: "2026-10-11T03:00:01.000Z",
	...over,
});

export const kpiDay: KpiDay = {
	day: "2026-10-10",
	turns: 10,
	replies: 7,
	ignores: 3,
	errors: 1,
	degraded: 0,
	fallback_used: 2,
	latency_p50_ms: 1200,
	latency_p95_ms: 3400,
	usage: {
		input_tokens: 1000,
		output_tokens: 200,
		cache_read_tokens: 50,
		cache_write_tokens: 10,
	},
};

export const stateHistory: StateHistoryResponse = {
	since: "2026-10-04T03:00:00.000Z",
	state_at_start: {
		mood: 0.5,
		energy: 0.6,
		presence: "active",
		system_stress: 0,
		degraded_mode: false,
	},
	transitions: [
		{
			id: "t1",
			occurred_at: "2026-10-05T03:00:00.000Z",
			reason: "turn_delta",
			source_event_id: "e1",
			before: {
				mood: 0.5,
				energy: 0.6,
				presence: "active",
				system_stress: 0,
				degraded_mode: false,
			},
			after: {
				mood: 0.6,
				energy: 0.55,
				presence: "active",
				system_stress: 0,
				degraded_mode: false,
			},
		},
		{
			id: "t2",
			occurred_at: "2026-10-07T03:00:00.000Z",
			reason: "llm_consecutive_failures",
			source_event_id: "e2",
			before: {
				mood: 0.6,
				energy: 0.55,
				presence: "active",
				system_stress: 0,
				degraded_mode: false,
			},
			after: {
				mood: 0.6,
				energy: 0.55,
				presence: "active",
				system_stress: 0.4,
				degraded_mode: true,
			},
		},
	],
	relationships: [
		{
			id: "r1",
			entity_id: "e-alice",
			display_name: "alice",
			occurred_at: "2026-10-06T03:00:00.000Z",
			reason: "turn",
			summary: "よく話した",
			familiarity_delta: 0.05,
			trust_delta: 0,
			familiarity: 0.35,
			trust: 0.5,
		},
	],
	truncated: false,
};

export const TEST_AGE_IDENTITY =
	"AGE-SECRET-KEY-1UQGWDU8C9AW57Q5RNA68L3J9LGLYUSYXXMQWYTENYGUESTNXMJKQX4KXX2";
export const TEST_AGE_RECIPIENT =
	"age1s23p452q2n8p2wv5cuqd8trvld0rw80kzrremgsrxdw7lxnx997qmpusg2";

/** 合成データのみ。 */
export const syntheticSnapshot = (): Snapshot => ({
	schema_version: 1,
	snapshot_id: "01990000-0000-7000-8000-000000000001",
	partner_id: "yukarin",
	env: "production",
	created_at: "2026-10-11T03:00:00.000Z",
	d1: {
		entities: [
			{
				id: "e1",
				kind: "person",
				display_name: "alice",
				created_at: "2026-10-01T00:00:00.000Z",
			},
		],
		external_identities: [
			{ provider: "discord", external_id: "u1", entity_id: "e1" },
		],
		facts: [],
		memory_candidates: [],
		open_loops: [],
		interest_states: [],
		opinion_states: [],
	},
	do: { state: null, relationships: [] },
});
