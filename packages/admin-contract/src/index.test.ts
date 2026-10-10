import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
	type AuditItem,
	AuditResponseSchema,
	MemoryResponseSchema,
	StatusResponseSchema,
} from "./index.ts";

const audit: AuditItem = {
	id: "a1",
	event_id: "e1",
	dedupe_key: "k",
	channel_id: "c",
	author_entity_id: null,
	kind: "turn",
	decision: "ignore",
	reason: "bot",
	decision_summary: null,
	model: null,
	fallback_used: false,
	degraded: false,
	error_type: null,
	usage: {
		input_tokens: 0,
		output_tokens: 0,
		cache_read_tokens: 0,
		cache_write_tokens: 0,
	},
	latency_ms: 0,
	inbound_content: "x",
	detail: {},
	occurred_at: "2026-10-11T03:00:00.000Z",
	created_at: "2026-10-11T03:00:01.000Z",
};

describe("admin-contract schemas", () => {
	it("audit 応答を受理する", () => {
		expect(
			v.safeParse(AuditResponseSchema, { items: [audit], next_cursor: null })
				.success,
		).toBe(true);
	});

	it("必須フィールドが欠けた audit は拒否する", () => {
		const { reason: _r, ...broken } = audit;
		expect(
			v.safeParse(AuditResponseSchema, { items: [broken], next_cursor: null })
				.success,
		).toBe(false);
	});

	it("memory 応答は kind で items の形を切り替える", () => {
		expect(
			v.safeParse(MemoryResponseSchema, {
				kind: "candidates",
				items: [{ id: "f" }],
				next_cursor: null,
			}).success,
		).toBe(false);
		expect(
			v.safeParse(MemoryResponseSchema, {
				kind: "facts",
				items: [],
				next_cursor: null,
			}).success,
		).toBe(true);
	});

	it("state が null の status を受理する", () => {
		expect(
			v.safeParse(StatusResponseSchema, {
				partner_id: "yukarin",
				env: "development",
				profile_version: 1,
				state: null,
				counts: { facts: 0, pending_candidates: 0 },
				last_audit_at: null,
			}).success,
		).toBe(true);
	});
});
