import * as v from "valibot";

export type Envelope<TType extends string = string, TPayload = unknown> = {
	event_id: string;
	type: TType;
	source: string;
	partner_id: string;
	occurred_at: string;
	received_at: string;
	schema_version: number;
	payload: TPayload;
};

export const envelopeSchema = <const TPayload extends v.GenericSchema>(
	payloadSchema: TPayload,
) =>
	v.object({
		event_id: v.pipe(v.string(), v.uuid()),
		type: v.pipe(v.string(), v.nonEmpty()),
		source: v.pipe(v.string(), v.nonEmpty()),
		partner_id: v.pipe(v.string(), v.nonEmpty()),
		occurred_at: v.pipe(v.string(), v.isoTimestamp()),
		received_at: v.pipe(v.string(), v.isoTimestamp()),
		schema_version: v.pipe(v.number(), v.integer(), v.minValue(1)),
		payload: payloadSchema,
	});
