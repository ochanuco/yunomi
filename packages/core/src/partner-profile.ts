import * as v from "valibot";
import { voiceProfileSchema } from "./voice-profile.ts";

const unit = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const signed = v.pipe(v.number(), v.minValue(-1), v.maxValue(1));
const clock = v.pipe(v.string(), v.regex(/^\d{1,2}:\d{2}$/));

export const capabilityModeSchema = v.picklist(["auto", "confirm", "deny"]);

export const partnerProfileSchema = v.object({
	schema_version: v.pipe(v.number(), v.integer(), v.minValue(1)),
	partner_id: v.pipe(v.string(), v.nonEmpty()),
	display_name: v.pipe(v.string(), v.nonEmpty()),
	aliases: v.array(v.pipe(v.string(), v.nonEmpty())),
	address_user: v.pipe(v.string(), v.nonEmpty()),
	speech: v.object({
		register: v.picklist(["polite", "casual"]),
		casualization_limit: unit,
	}),
	values: v.array(
		v.object({
			name: v.pipe(v.string(), v.nonEmpty()),
			kind: v.picklist(["value", "dislike", "boundary"]),
			strength: unit,
			description: v.string(),
		}),
	),
	interests: v.array(
		v.object({
			topic: v.pipe(v.string(), v.nonEmpty()),
			label: v.pipe(v.string(), v.nonEmpty()),
			baseline: unit,
			summary: v.string(),
		}),
	),
	opinions: v.array(
		v.object({
			topic: v.pipe(v.string(), v.nonEmpty()),
			label: v.pipe(v.string(), v.nonEmpty()),
			stance: v.pipe(v.string(), v.nonEmpty()),
			confidence: unit,
			stability: unit,
		}),
	),
	living_rhythm: v.object({
		timezone: v.pipe(v.string(), v.nonEmpty()),
		lifestyle_day_boundary: clock,
		typical_sleep: v.pipe(v.string(), v.regex(/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/)),
	}),
	recurring_jokes: v.array(
		v.object({
			id: v.pipe(v.string(), v.nonEmpty()),
			text_hint: v.string(),
			cooldown_minutes: v.pipe(v.number(), v.integer(), v.minValue(0)),
		}),
	),
	initial_state: v.object({ mood: signed, energy: unit }),
	initial_relationship: v.object({ familiarity: unit, trust: unit }),
	capability_defaults: v.record(v.string(), capabilityModeSchema),
	voice: v.optional(voiceProfileSchema),
	identity: v.object({
		official: v.string(),
		fanon: v.string(),
		yunomi: v.string(),
	}),
});

export type PartnerProfile = v.InferOutput<typeof partnerProfileSchema>;
