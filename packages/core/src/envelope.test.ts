import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { envelopeSchema } from "./envelope.ts";
import { newId } from "./id.ts";

const schema = envelopeSchema(v.object({ text: v.string() }));

const valid = () => ({
	event_id: newId(),
	type: "message.received",
	source: "gateway",
	partner_id: "partner-1",
	occurred_at: "2026-01-01T00:00:00.000Z",
	received_at: "2026-01-01T00:00:01.000Z",
	schema_version: 1,
	payload: { text: "hi" },
});

describe("envelopeSchema", () => {
	it("正常な Envelope を受理する", () => {
		expect(v.safeParse(schema, valid()).success).toBe(true);
	});

	it("payload が payloadSchema に反すると拒否する", () => {
		expect(
			v.safeParse(schema, { ...valid(), payload: { text: 1 } }).success,
		).toBe(false);
	});

	it("必須フィールド欠落を拒否する", () => {
		const { partner_id: _, ...rest } = valid();
		expect(v.safeParse(schema, rest).success).toBe(false);
	});

	it("ISO 形式でない時刻と不正な schema_version を拒否する", () => {
		expect(
			v.safeParse(schema, { ...valid(), occurred_at: "yesterday" }).success,
		).toBe(false);
		expect(v.safeParse(schema, { ...valid(), schema_version: 0 }).success).toBe(
			false,
		);
		expect(
			v.safeParse(schema, { ...valid(), schema_version: 1.5 }).success,
		).toBe(false);
	});
});
