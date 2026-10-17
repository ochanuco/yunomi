import * as v from "valibot";

/**
 * Admin 読み取り API（`/admin/api/partners/:partnerId/...`）の応答。
 * Worker は型に合わせて返し、`ykm` と Admin Web はスキーマで検証する。
 * 時刻は UTC の ISO 8601。表示側で JST に変換する。
 */

export const ADMIN_API_PREFIX = "/admin/api";

export type PartnerStateView = {
	mood: number;
	energy: number;
	presence: string;
	system_stress: number;
	degraded_mode: boolean;
	version: number;
	updated_at: string;
};

export type StatusResponse = {
	partner_id: string;
	env: string;
	profile_version: number;
	/** 初回のターンを処理するまでは null。 */
	state: PartnerStateView | null;
	counts: {
		/** 失効も上書きもされていない現行の Fact。 */
		facts: number;
		/** 昇格・棄却の判断待ちの candidate。 */
		pending_candidates: number;
	};
	last_audit_at: string | null;
};

export type RelationshipView = {
	entity_id: string;
	display_name: string | null;
	familiarity: number;
	trust: number;
	summary: string | null;
	version: number;
	updated_at: string;
};

export type RelationshipsResponse = { items: RelationshipView[] };

export type FactView = {
	id: string;
	subject_entity_id: string;
	predicate: string;
	object_type: string;
	object_value: string;
	object_display: string | null;
	confidence: number;
	importance: number;
	source: string;
	observed_at: string;
	valid_from: string;
	valid_to: string | null;
	superseded_by: string | null;
};

export type CandidateStatus = "pending" | "promoted" | "conflict" | "rejected";

export type CandidateView = {
	id: string;
	subject_entity_id: string | null;
	subject_text: string | null;
	predicate: string;
	object_type: string;
	object_value: string;
	confidence: number;
	importance: number;
	source: string;
	status: CandidateStatus;
	conflict_fact_id: string | null;
	expires_at: string;
	created_at: string;
	source_event_id: string;
};

export type MemoryKind = "facts" | "candidates";

/** `all` は置き換え済み・期限切れの Fact も含める。省略時は現行の Fact だけ。 */
export type MemoryInclude = "all";

export type FactsResponse = {
	kind: "facts";
	items: FactView[];
	next_cursor: string | null;
};

export type CandidatesResponse = {
	kind: "candidates";
	items: CandidateView[];
	next_cursor: string | null;
};

export type MemoryResponse = FactsResponse | CandidatesResponse;

export type OpenLoopStatus = "open" | "resolved" | "dropped";

/** `all` は resolved / dropped も含める。省略時は open だけ。 */
export type OpenLoopsFilter = "open" | "all";

export type OpenLoopView = {
	id: string;
	entity_id: string;
	/** 話し相手の表示名。entity が見つからなければ null。 */
	entity_display_name: string | null;
	channel_id: string;
	summary: string;
	importance: number;
	due_at: string | null;
	due_confidence: number | null;
	follow_up_interval_hours: number | null;
	status: OpenLoopStatus;
	source_message_id: string;
	created_at: string;
	updated_at: string;
	resolved_at: string | null;
	last_followed_up_at: string | null;
};

/** 新しい順。 */
export type OpenLoopsResponse = {
	items: OpenLoopView[];
	next_cursor: string | null;
};

/** `profile` は学習前のプロファイル初期値、`learned` は変化の履歴がある行。 */
export type InterestOpinionSource = "profile" | "learned";

export type InterestView = {
	topic: string;
	label: string;
	score: number;
	baseline: number;
	learned_delta: number;
	summary: string;
	/** 学習前（source が profile）は null。 */
	updated_at: string | null;
	source: InterestOpinionSource;
};

/** score の降順。 */
export type InterestsResponse = { items: InterestView[] };

export type OpinionView = {
	topic: string;
	label: string;
	stance: string;
	confidence: number;
	stability: number;
	reasons: string[];
	source_memory_ids: string[];
	updated_at: string | null;
	source: InterestOpinionSource;
};

/** プロファイルの定義順。 */
export type OpinionsResponse = { items: OpinionView[] };

export type AuditItem = {
	id: string;
	event_id: string;
	dedupe_key: string;
	channel_id: string;
	author_entity_id: string | null;
	kind: "turn";
	decision: "reply" | "ignore";
	reason: string;
	decision_summary: string | null;
	model: string | null;
	fallback_used: boolean;
	degraded: boolean;
	error_type: string | null;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number;
		cache_write_tokens: number;
	};
	latency_ms: number;
	/** 受信本文。保持期間（30 日）を過ぎると行ごと消える。 */
	inbound_content: string;
	/** state / relationship / memory / openLoops / interestOpinion / toolCalls など。形は Worker 側の実装に従う。 */
	detail: Record<string, unknown>;
	occurred_at: string;
	created_at: string;
};

/** 新しい順。 */
export type AuditResponse = {
	items: AuditItem[];
	next_cursor: string | null;
};

/** 確定した生活日（JST 05:00 境界）ごとの集計。audit が消えた後も残る。 */
export type KpiDay = {
	/** 生活日 `YYYY-MM-DD`。 */
	day: string;
	turns: number;
	replies: number;
	ignores: number;
	/** error_type を持つターン。成功率は 1 - errors / turns。 */
	errors: number;
	degraded: number;
	fallback_used: number;
	/** reply ターンの latency。reply が無い日は null。 */
	latency_p50_ms: number | null;
	latency_p95_ms: number | null;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_tokens: number;
		cache_write_tokens: number;
	};
};

/** 新しい日が先。当日（進行中）は含まない。 */
export type KpisResponse = { items: KpiDay[] };

export type ApiError = { error: string };

const nullable = <T extends v.GenericSchema>(s: T) => v.nullable(s);
const str = v.string();
const num = v.number();
const bool = v.boolean();

export const PartnerStateViewSchema: v.GenericSchema<PartnerStateView> =
	v.object({
		mood: num,
		energy: num,
		presence: str,
		system_stress: num,
		degraded_mode: bool,
		version: num,
		updated_at: str,
	});

export const StatusResponseSchema: v.GenericSchema<StatusResponse> = v.object({
	partner_id: str,
	env: str,
	profile_version: num,
	state: nullable(PartnerStateViewSchema),
	counts: v.object({ facts: num, pending_candidates: num }),
	last_audit_at: nullable(str),
});

export const RelationshipViewSchema: v.GenericSchema<RelationshipView> =
	v.object({
		entity_id: str,
		display_name: nullable(str),
		familiarity: num,
		trust: num,
		summary: nullable(str),
		version: num,
		updated_at: str,
	});

export const RelationshipsResponseSchema: v.GenericSchema<RelationshipsResponse> =
	v.object({ items: v.array(RelationshipViewSchema) });

export const FactViewSchema: v.GenericSchema<FactView> = v.object({
	id: str,
	subject_entity_id: str,
	predicate: str,
	object_type: str,
	object_value: str,
	object_display: nullable(str),
	confidence: num,
	importance: num,
	source: str,
	observed_at: str,
	valid_from: str,
	valid_to: nullable(str),
	superseded_by: nullable(str),
});

export const CandidateViewSchema: v.GenericSchema<CandidateView> = v.object({
	id: str,
	subject_entity_id: nullable(str),
	subject_text: nullable(str),
	predicate: str,
	object_type: str,
	object_value: str,
	confidence: num,
	importance: num,
	source: str,
	status: v.picklist(["pending", "promoted", "conflict", "rejected"]),
	conflict_fact_id: nullable(str),
	expires_at: str,
	created_at: str,
	source_event_id: str,
});

export const MemoryResponseSchema: v.GenericSchema<MemoryResponse> = v.variant(
	"kind",
	[
		v.object({
			kind: v.literal("facts"),
			items: v.array(FactViewSchema),
			next_cursor: nullable(str),
		}),
		v.object({
			kind: v.literal("candidates"),
			items: v.array(CandidateViewSchema),
			next_cursor: nullable(str),
		}),
	],
);

export const OpenLoopViewSchema: v.GenericSchema<OpenLoopView> = v.object({
	id: str,
	entity_id: str,
	entity_display_name: nullable(str),
	channel_id: str,
	summary: str,
	importance: num,
	due_at: nullable(str),
	due_confidence: nullable(num),
	follow_up_interval_hours: nullable(num),
	status: v.picklist(["open", "resolved", "dropped"]),
	source_message_id: str,
	created_at: str,
	updated_at: str,
	resolved_at: nullable(str),
	last_followed_up_at: nullable(str),
});

export const OpenLoopsResponseSchema: v.GenericSchema<OpenLoopsResponse> =
	v.object({
		items: v.array(OpenLoopViewSchema),
		next_cursor: nullable(str),
	});

const interestOpinionSource = v.picklist(["profile", "learned"]);

export const InterestViewSchema: v.GenericSchema<InterestView> = v.object({
	topic: str,
	label: str,
	score: num,
	baseline: num,
	learned_delta: num,
	summary: str,
	updated_at: nullable(str),
	source: interestOpinionSource,
});

export const InterestsResponseSchema: v.GenericSchema<InterestsResponse> =
	v.object({ items: v.array(InterestViewSchema) });

export const OpinionViewSchema: v.GenericSchema<OpinionView> = v.object({
	topic: str,
	label: str,
	stance: str,
	confidence: num,
	stability: num,
	reasons: v.array(str),
	source_memory_ids: v.array(str),
	updated_at: nullable(str),
	source: interestOpinionSource,
});

export const OpinionsResponseSchema: v.GenericSchema<OpinionsResponse> =
	v.object({ items: v.array(OpinionViewSchema) });

export const AuditItemSchema: v.GenericSchema<AuditItem> = v.object({
	id: str,
	event_id: str,
	dedupe_key: str,
	channel_id: str,
	author_entity_id: nullable(str),
	kind: v.literal("turn"),
	decision: v.picklist(["reply", "ignore"]),
	reason: str,
	decision_summary: nullable(str),
	model: nullable(str),
	fallback_used: bool,
	degraded: bool,
	error_type: nullable(str),
	usage: v.object({
		input_tokens: num,
		output_tokens: num,
		cache_read_tokens: num,
		cache_write_tokens: num,
	}),
	latency_ms: num,
	inbound_content: str,
	detail: v.record(str, v.unknown()),
	occurred_at: str,
	created_at: str,
});

export const AuditResponseSchema: v.GenericSchema<AuditResponse> = v.object({
	items: v.array(AuditItemSchema),
	next_cursor: nullable(str),
});

export const KpiDaySchema: v.GenericSchema<KpiDay> = v.object({
	day: str,
	turns: num,
	replies: num,
	ignores: num,
	errors: num,
	degraded: num,
	fallback_used: num,
	latency_p50_ms: nullable(num),
	latency_p95_ms: nullable(num),
	usage: v.object({
		input_tokens: num,
		output_tokens: num,
		cache_read_tokens: num,
		cache_write_tokens: num,
	}),
});

export const KpisResponseSchema: v.GenericSchema<KpisResponse> = v.object({
	items: v.array(KpiDaySchema),
});

export const ApiErrorSchema: v.GenericSchema<ApiError> = v.object({
	error: str,
});

/**
 * Partner Snapshot。D1 の長期記憶と DO の現在値の時点コピー。
 * 会話本文（recent_messages）、audit、KPI、履歴テーブル、secret は含めない。
 * 行は partner_id を持たない（Snapshot 全体の partner_id に従う）。
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** R2 の customMetadata。一覧はこの値から組み立てる。 */
export type SnapshotSummary = {
	id: string;
	created_at: string;
	size: number;
	schema_version: number;
	env: string;
};

export type SnapshotsResponse = { items: SnapshotSummary[] };

export type SnapshotRestoreCounts = {
	entities: number;
	external_identities: number;
	facts: number;
	memory_candidates: number;
	open_loops: number;
	interest_states: number;
	opinion_states: number;
	relationships: number;
};

export type SnapshotRestoreResponse = {
	snapshot_id: string;
	source_env: string;
	counts: SnapshotRestoreCounts;
};

const int = v.pipe(v.number(), v.integer());

export const SnapshotSchema = v.strictObject({
	schema_version: v.literal(SNAPSHOT_SCHEMA_VERSION),
	snapshot_id: str,
	partner_id: str,
	env: str,
	created_at: str,
	d1: v.strictObject({
		entities: v.array(
			v.strictObject({
				id: str,
				kind: str,
				display_name: str,
				created_at: str,
			}),
		),
		external_identities: v.array(
			v.strictObject({ provider: str, external_id: str, entity_id: str }),
		),
		facts: v.array(
			v.strictObject({
				id: str,
				subject_entity_id: str,
				predicate: str,
				object_type: str,
				object_value: str,
				object_display: nullable(str),
				confidence: num,
				importance: num,
				source: str,
				observed_at: str,
				valid_from: str,
				valid_to: nullable(str),
				decay_policy: str,
				superseded_by: nullable(str),
			}),
		),
		memory_candidates: v.array(
			v.strictObject({
				id: str,
				subject_entity_id: nullable(str),
				subject_text: nullable(str),
				predicate: str,
				object_type: str,
				object_value: str,
				confidence: num,
				importance: num,
				source: str,
				status: v.picklist(["pending", "promoted", "conflict", "rejected"]),
				conflict_fact_id: nullable(str),
				expires_at: str,
				created_at: str,
				source_event_id: str,
			}),
		),
		open_loops: v.array(
			v.strictObject({
				id: str,
				entity_id: str,
				channel_id: str,
				summary: str,
				importance: num,
				due_at: nullable(str),
				due_confidence: nullable(num),
				follow_up_interval_hours: nullable(num),
				status: v.picklist(["open", "resolved", "dropped"]),
				source_message_id: str,
				created_at: str,
				updated_at: str,
				resolved_at: nullable(str),
				last_followed_up_at: nullable(str),
			}),
		),
		interest_states: v.array(
			v.strictObject({
				topic: str,
				score: num,
				baseline: num,
				learned_delta: num,
				summary: str,
				updated_at: str,
				source: interestOpinionSource,
			}),
		),
		opinion_states: v.array(
			v.strictObject({
				topic: str,
				stance: str,
				confidence: num,
				stability: num,
				reasons: str,
				source_memory_ids: str,
				updated_at: str,
			}),
		),
	}),
	do: v.strictObject({
		state: nullable(PartnerStateViewSchema),
		relationships: v.array(
			v.strictObject({
				entity_id: str,
				familiarity: num,
				trust: num,
				summary: nullable(str),
				version: int,
				updated_at: str,
				acc_day: str,
				acc_familiarity: num,
				acc_trust: num,
			}),
		),
	}),
});

export type Snapshot = v.InferOutput<typeof SnapshotSchema>;

export const SnapshotSummarySchema: v.GenericSchema<SnapshotSummary> = v.object(
	{ id: str, created_at: str, size: num, schema_version: num, env: str },
);

export const SnapshotsResponseSchema: v.GenericSchema<SnapshotsResponse> =
	v.object({ items: v.array(SnapshotSummarySchema) });

export const SnapshotRestoreResponseSchema: v.GenericSchema<SnapshotRestoreResponse> =
	v.object({
		snapshot_id: str,
		source_env: str,
		counts: v.object({
			entities: num,
			external_identities: num,
			facts: num,
			memory_candidates: num,
			open_loops: num,
			interest_states: num,
			opinion_states: num,
			relationships: num,
		}),
	});
