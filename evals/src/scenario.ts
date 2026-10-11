import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptInput } from "@yunomi/conversation";
import {
	type PartnerProfile,
	resolveInterests,
	resolveOpinions,
} from "@yunomi/core";
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
	/** 返信のうち Open Loop を 1 件以上抽出した割合の許容範囲。省略すると見ない。 */
	open_loop_rate: v.optional(range),
	/** 返信のうち memory_candidates を 1 件以上出した割合の許容範囲。省略すると見ない。 */
	memory_candidate_rate: v.optional(range),
	/** 返信のうち、プロファイルにある topic の opinion_signals に shift を含めた割合の許容範囲。省略すると見ない。 */
	opinion_shift_rate: v.optional(range),
	/** 返信のうち、プロファイルにある topic の interest_signals に up を含めた割合の許容範囲。省略すると見ない。 */
	interest_up_rate: v.optional(range),
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
	now: Date = new Date(),
): PromptInput => ({
	profile,
	jokeStatus: scenario.joke_status,
	state: scenario.state,
	relationship: {
		speakerName: scenario.message.speaker,
		...scenario.relationship,
	},
	memory: [],
	interests: resolveInterests(profile, [])
		.sort((a, b) => b.score - a.score)
		.map((i) => ({
			topic: i.topic,
			label: i.label,
			score: i.score,
			summary: i.summary,
		})),
	opinions: resolveOpinions(profile, []).map((o) => ({
		topic: o.topic,
		label: o.label,
		stance: o.stance,
		confidence: o.confidence,
	})),
	openLoops: [],
	now,
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
