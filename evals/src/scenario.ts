import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptInput } from "@yunomi/conversation";
import type { PartnerProfile } from "@yunomi/core";
import * as v from "valibot";
import { parse } from "yaml";

const unit = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

const range = v.pipe(
	v.object({ min: unit, max: unit }),
	v.check((r) => r.min <= r.max, "min は max 以下にする"),
);

const line = v.object({
	speaker: v.pipe(v.string(), v.minLength(1)),
	text: v.pipe(v.string(), v.minLength(1)),
});

/** 期待は個々の出力の一致ではなく、複数サンプルで見る傾向として書く。 */
export const expectationsSchema = v.object({
	reply_rate: range,
	must_be_polite: v.boolean(),
	/** politeness_score の平均がこれを下回ると違反。must_be_polite が true のときだけ見る。 */
	polite_min: v.optional(unit, 0.8),
	should_not_over_agree: v.boolean(),
	/** 返信のうち文末が質問になってよい割合の上限。 */
	question_ending_rate_max: v.optional(unit),
	must_not_claim_unperformed_action: v.optional(v.boolean(), false),
	must_not_invent_facts: v.optional(v.boolean(), false),
	/** cooling_down の持ちネタを使わない。 */
	joke_cooldown_respected: v.optional(v.boolean(), false),
	persona_consistency_min: v.optional(unit, 0.6),
});

export const scenarioSchema = v.object({
	id: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/)),
	description: v.pipe(v.string(), v.minLength(1)),
	recent: v.array(line),
	message: v.object({
		speaker: v.pipe(v.string(), v.minLength(1)),
		text: v.pipe(v.string(), v.minLength(1)),
		mentions_partner: v.boolean(),
	}),
	relationship: v.object({ familiarity: unit, trust: unit }),
	state: v.object({
		mood: v.pipe(v.number(), v.minValue(-1), v.maxValue(1)),
		energy: unit,
	}),
	/** recurring_jokes の id → 状態。未指定は available。 */
	joke_status: v.optional(
		v.record(v.string(), v.picklist(["available", "cooling_down"])),
		{},
	),
	expectations: expectationsSchema,
});

export type Scenario = v.InferOutput<typeof scenarioSchema>;
export type Expectations = Scenario["expectations"];

export const scenariosDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../scenarios",
);

/** ファイル名順に読む。id の重複と、profile に無い持ちネタ id は境界で弾く。 */
export const loadScenarios = (
	dir: string = scenariosDir,
	profile?: PartnerProfile,
): Scenario[] => {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".yaml"))
		.sort();
	const scenarios = files.map((f) => {
		const parsed = v.safeParse(
			scenarioSchema,
			parse(readFileSync(join(dir, f), "utf8")),
		);
		if (!parsed.success) {
			const issues = parsed.issues
				.map((i) => `${v.getDotPath(i) ?? "(root)"}: ${i.message}`)
				.join("; ");
			throw new Error(`シナリオ ${f} が不正: ${issues}`);
		}
		return parsed.output;
	});

	const seen = new Set<string>();
	for (const s of scenarios) {
		if (seen.has(s.id)) throw new Error(`シナリオ id が重複: ${s.id}`);
		seen.add(s.id);
		if (profile) {
			const known = new Set(profile.recurring_jokes.map((j) => j.id));
			for (const id of Object.keys(s.joke_status)) {
				if (!known.has(id)) {
					throw new Error(`シナリオ ${s.id} が未知の持ちネタ ${id} を参照`);
				}
			}
		}
	}
	return scenarios;
};

export const toPromptInput = (
	scenario: Scenario,
	profile: PartnerProfile,
): PromptInput => ({
	profile,
	jokeStatus: scenario.joke_status,
	state: scenario.state,
	relationship: {
		speakerName: scenario.message.speaker,
		...scenario.relationship,
	},
	memory: [],
	channel: {
		name: "general",
		presence: `${scenario.message.speaker} がオンライン`,
	},
	recent: scenario.recent,
	message: {
		speaker: scenario.message.speaker,
		text: scenario.message.text,
		mentionsPartner: scenario.message.mentions_partner,
	},
});
