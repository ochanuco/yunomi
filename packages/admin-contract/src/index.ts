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
	/** state / relationship / memory / tool_intents など。形は Worker 側の実装に従う。 */
	detail: Record<string, unknown>;
	occurred_at: string;
	created_at: string;
};

/** 新しい順。 */
export type AuditResponse = {
	items: AuditItem[];
	next_cursor: string | null;
};

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

export const ApiErrorSchema: v.GenericSchema<ApiError> = v.object({
	error: str,
});
