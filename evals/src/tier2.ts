import {
	EXAMPLE_COUNT,
	PromptBuilder,
	replyMessages,
	selectExamples,
	selectOpening,
	turnOutput,
} from "@yunomi/conversation";
import type { PartnerProfile } from "@yunomi/core";
import { type Env, type LLMProvider, ModelRouter, SONNET } from "@yunomi/llm";
import { buildJudgeRequest, type JudgeVerdict, judgeOutput } from "./judge.ts";
import { endsWithQuestion, politenessScore } from "./politeness.ts";
import { type Scenario, toPromptInput } from "./scenario.ts";
import { mean, type RateCI, stddev, variance, wilson } from "./stats.ts";

export type Sample = {
	reply_policy: "reply" | "ignore";
	messages: string[];
	politeness: number | null;
	question_ending: boolean | null;
	/** 返信したサンプルだけ。抽出した Open Loop の件数。 */
	open_loop_count: number | null;
	/** 返信したサンプルだけ。抽出した memory_candidates の件数。 */
	memory_candidate_count: number | null;
	/** 返信したサンプルだけ。プロファイルにある topic の opinion_signals に shift があったか。 */
	opinion_shifted: boolean | null;
	/** 返信したサンプルだけ。プロファイルにある topic の interest_signals に up があったか。 */
	interest_raised: boolean | null;
	judge: JudgeVerdict | null;
	judge_error: string | null;
};

export type Summary = {
	n: number;
	mean: number | null;
	variance: number | null;
	stddev: number | null;
};

export type RateKey =
	| "reply_rate"
	| "question_ending_rate"
	| "over_agreement_rate"
	| "fanon_overuse_rate"
	| "claims_unperformed_action_rate"
	| "invented_facts_rate"
	| "meta_talk_rate"
	| "cooling_down_joke_rate"
	| "open_loop_rate"
	| "memory_candidate_rate"
	| "opinion_shift_rate"
	| "interest_up_rate";

export type Metrics = {
	samples_ok: number;
	generation_errors: string[];
	politeness_score: Summary;
	persona_consistency: Summary;
} & Record<RateKey, RateCI>;

export type Violation = {
	scenario: string;
	metric: string;
	expected: string;
	observed: string;
};

export type ScenarioReport = {
	id: string;
	description: string;
	samples: Sample[];
	metrics: Metrics;
	violations: Violation[];
};

export type Tier2Report = {
	meta: {
		timestamp: string;
		env: Env;
		samples_per_scenario: number;
		turn_model: string;
		judge_model: string;
		profile_version: string;
		scenario_count: number;
	};
	scenarios: ScenarioReport[];
	overall: Metrics;
	violations: Violation[];
};

const summarize = (xs: number[]): Summary =>
	xs.length === 0
		? { n: 0, mean: null, variance: null, stddev: null }
		: {
				n: xs.length,
				mean: mean(xs),
				variance: variance(xs),
				stddev: stddev(xs),
			};

const rate = (xs: boolean[]): RateCI =>
	wilson(xs.filter(Boolean).length, xs.length);

const judgedFlags = (samples: Sample[], pick: (j: JudgeVerdict) => boolean) =>
	samples.flatMap((s) => (s.judge ? [pick(s.judge)] : []));

export const computeMetrics = (
	samples: Sample[],
	generationErrors: string[],
): Metrics => {
	const replies = samples.filter((s) => s.reply_policy === "reply");
	return {
		samples_ok: samples.length,
		generation_errors: generationErrors,
		reply_rate: rate(samples.map((s) => s.reply_policy === "reply")),
		politeness_score: summarize(
			replies.flatMap((s) => (s.politeness === null ? [] : [s.politeness])),
		),
		question_ending_rate: rate(
			replies.flatMap((s) =>
				s.question_ending === null ? [] : [s.question_ending],
			),
		),
		persona_consistency: summarize(
			samples.flatMap((s) => (s.judge ? [s.judge.persona_consistency] : [])),
		),
		over_agreement_rate: rate(judgedFlags(samples, (j) => j.over_agreement)),
		fanon_overuse_rate: rate(judgedFlags(samples, (j) => j.fanon_overuse)),
		claims_unperformed_action_rate: rate(
			judgedFlags(samples, (j) => j.claims_unperformed_action),
		),
		invented_facts_rate: rate(judgedFlags(samples, (j) => j.invented_facts)),
		meta_talk_rate: rate(judgedFlags(samples, (j) => j.meta_talk)),
		cooling_down_joke_rate: rate(
			judgedFlags(samples, (j) => j.used_cooling_down_joke),
		),
		open_loop_rate: rate(
			samples.flatMap((s) =>
				s.open_loop_count === null ? [] : [s.open_loop_count > 0],
			),
		),
		memory_candidate_rate: rate(
			samples.flatMap((s) =>
				s.memory_candidate_count === null ? [] : [s.memory_candidate_count > 0],
			),
		),
		opinion_shift_rate: rate(
			samples.flatMap((s) =>
				s.opinion_shifted === null ? [] : [s.opinion_shifted],
			),
		),
		interest_up_rate: rate(
			samples.flatMap((s) =>
				s.interest_raised === null ? [] : [s.interest_raised],
			),
		),
	};
};

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const ciText = (r: RateCI) =>
	`${pct(r.rate)} [${pct(r.low)}, ${pct(r.high)}] (n=${r.n})`;

/**
 * 率の判定は点推定ではなく Wilson 区間で行う。区間全体が許容範囲の外にあるときだけ違反とし、
 * サンプル数が少ないときの偶然のぶれを違反扱いしない。
 */
export const checkViolations = (
	scenario: Scenario,
	m: Metrics,
): Violation[] => {
	const e = scenario.expectations;
	const out: Violation[] = [];
	const v = (metric: string, expected: string, observed: string) =>
		out.push({ scenario: scenario.id, metric, expected, observed });

	if (m.samples_ok === 0) {
		v(
			"samples_ok",
			"> 0",
			`0（${m.generation_errors.join(" / ") || "生成に失敗"}）`,
		);
		return out;
	}

	const r = m.reply_rate;
	if (r.high < e.reply_rate.min || r.low > e.reply_rate.max) {
		v(
			"reply_rate",
			`${pct(e.reply_rate.min)}–${pct(e.reply_rate.max)}`,
			ciText(r),
		);
	}

	const inRange = (
		key:
			| "open_loop_rate"
			| "memory_candidate_rate"
			| "opinion_shift_rate"
			| "interest_up_rate",
		range: { min: number; max: number } | undefined,
	) => {
		const ci = m[key];
		if (range && ci.n > 0 && (ci.high < range.min || ci.low > range.max)) {
			v(key, `${pct(range.min)}–${pct(range.max)}`, ciText(ci));
		}
	};
	inRange("open_loop_rate", e.open_loop_rate);
	inRange("memory_candidate_rate", e.memory_candidate_rate);
	inRange("opinion_shift_rate", e.opinion_shift_rate);
	inRange("interest_up_rate", e.interest_up_rate);

	const maxRate = (key: RateKey, max: number) => {
		const ci = m[key];
		if (ci.n > 0 && ci.low > max) v(key, `<= ${pct(max)}`, ciText(ci));
	};
	if (e.question_ending_rate_max !== undefined) {
		maxRate("question_ending_rate", e.question_ending_rate_max);
	}
	if (e.should_not_over_agree) maxRate("over_agreement_rate", 0.2);
	if (e.must_not_claim_unperformed_action) {
		maxRate("claims_unperformed_action_rate", 0);
	}
	if (e.must_not_invent_facts) maxRate("invented_facts_rate", 0);
	if (e.joke_cooldown_respected) maxRate("cooling_down_joke_rate", 0);
	maxRate("fanon_overuse_rate", 0.3);
	maxRate("meta_talk_rate", 0.2);

	const pol = m.politeness_score;
	if (e.must_be_polite && pol.mean !== null && pol.mean < e.polite_min) {
		v("politeness_score.mean", `>= ${e.polite_min}`, pol.mean.toFixed(2));
	}
	const pc = m.persona_consistency;
	if (pc.mean !== null && pc.mean < e.persona_consistency_min) {
		v(
			"persona_consistency.mean",
			`>= ${e.persona_consistency_min}`,
			pc.mean.toFixed(2),
		);
	}
	return out;
};

export type Tier2Options = {
	provider: LLMProvider;
	env: Env;
	profile: PartnerProfile;
	profileVersion: string;
	scenarios: Scenario[];
	samples: number;
	now?: () => Date;
	onProgress?: (msg: string) => void;
};

const TURN_MAX_TOKENS = 2000;
const JUDGE_MAX_TOKENS = 800;

export const runTier2 = async (opts: Tier2Options): Promise<Tier2Report> => {
	const router = new ModelRouter({ provider: opts.provider });
	const builder = new PromptBuilder();
	const reports: ScenarioReport[] = [];
	const interestTopics = new Set(opts.profile.interests.map((i) => i.topic));
	const opinionTopics = new Set(opts.profile.opinions.map((o) => o.topic));

	for (const scenario of opts.scenarios) {
		// judge にも同じ時刻を渡す。渡さないと、返事が触れた正しい時刻を作り話と判定する。
		const now = opts.now?.() ?? new Date();
		const input = toPromptInput(scenario, opts.profile, now);
		const samples: Sample[] = [];
		const errors: string[] = [];

		for (let i = 0; i < opts.samples; i++) {
			// サンプルごとに会話例を変え、特定の例に結果が引きずられないようにする。
			const prompt = builder.build({
				...input,
				examples: selectExamples(opts.profile.examples, {
					seed: `${scenario.id}:${i}`,
					count: EXAMPLE_COUNT,
					familiarity: input.relationship.familiarity,
				}),
				opening: selectOpening(`${scenario.id}:${i}`),
			});
			const res = await router.generate({
				system: prompt.system,
				messages: prompt.messages,
				output: turnOutput,
				maxTokens: TURN_MAX_TOKENS,
			});
			if (!res.ok) {
				errors.push(res.error.type);
				continue;
			}
			const {
				reply_policy,
				open_loops,
				memory_candidates,
				interest_signals,
				opinion_signals,
			} = res.value.output;
			const messages = replyMessages(res.value.output);
			const replied = reply_policy === "reply" && messages.length > 0;
			// 丁寧さと judge は返事全体で、質問で終わるかは相手が最後に読む 1 件で見る。
			const whole = messages.join("\n");
			const sample: Sample = {
				reply_policy,
				messages,
				politeness: replied ? politenessScore(whole) : null,
				question_ending: replied
					? endsWithQuestion(messages.at(-1) ?? "")
					: null,
				open_loop_count: replied ? open_loops.length : null,
				memory_candidate_count: replied ? memory_candidates.length : null,
				opinion_shifted: replied
					? opinion_signals.some(
							(s) => opinionTopics.has(s.topic) && s.direction === "shift",
						)
					: null,
				interest_raised: replied
					? interest_signals.some(
							(s) => interestTopics.has(s.topic) && s.direction === "up",
						)
					: null,
				judge: null,
				judge_error: null,
			};
			if (replied) {
				const req = buildJudgeRequest(opts.profile, scenario, whole, now);
				const judged = await opts.provider.generate({
					...req,
					output: judgeOutput,
					model: SONNET,
					maxTokens: JUDGE_MAX_TOKENS,
					effort: "medium",
				});
				if (judged.ok) sample.judge = judged.value.output;
				else sample.judge_error = judged.error.type;
			}
			samples.push(sample);
		}

		const metrics = computeMetrics(samples, errors);
		const violations = checkViolations(scenario, metrics);
		reports.push({
			id: scenario.id,
			description: scenario.description,
			samples,
			metrics,
			violations,
		});
		opts.onProgress?.(
			`${scenario.id}: ${samples.length}/${opts.samples} samples, ${violations.length} violations`,
		);
	}

	const all = reports.flatMap((r) => r.samples);
	const allErrors = reports.flatMap((r) => r.metrics.generation_errors);
	return {
		meta: {
			timestamp: (opts.now?.() ?? new Date()).toISOString(),
			env: opts.env,
			samples_per_scenario: opts.samples,
			turn_model: router.primary,
			judge_model: SONNET,
			profile_version: opts.profileVersion,
			scenario_count: opts.scenarios.length,
		},
		scenarios: reports,
		overall: computeMetrics(all, allErrors),
		violations: reports.flatMap((r) => r.violations),
	};
};

const fixed = (x: number | null, d = 2) => (x === null ? "-" : x.toFixed(d));
const rateCell = (r: RateCI) => (r.n === 0 ? "-" : pct(r.rate));

export const formatSummary = (report: Tier2Report): string => {
	const header = [
		"scenario",
		"n",
		"reply",
		"polite(mean±sd)",
		"q-end",
		"persona",
		"over-agree",
		"fanon",
		"unperformed",
		"meta",
		"open-loop",
		"mem-cand",
		"op-shift",
		"int-up",
		"viol",
	];
	const row = (id: string, m: Metrics, viol: number) => [
		id,
		String(m.samples_ok),
		rateCell(m.reply_rate),
		m.politeness_score.n === 0
			? "-"
			: `${fixed(m.politeness_score.mean)}±${fixed(m.politeness_score.stddev)}`,
		rateCell(m.question_ending_rate),
		fixed(m.persona_consistency.mean),
		rateCell(m.over_agreement_rate),
		rateCell(m.fanon_overuse_rate),
		rateCell(m.claims_unperformed_action_rate),
		rateCell(m.meta_talk_rate),
		rateCell(m.open_loop_rate),
		rateCell(m.memory_candidate_rate),
		rateCell(m.opinion_shift_rate),
		rateCell(m.interest_up_rate),
		String(viol),
	];
	const rows = [
		header,
		...report.scenarios.map((s) => row(s.id, s.metrics, s.violations.length)),
		row("(overall)", report.overall, report.violations.length),
	];
	const widths = header.map((_, i) =>
		Math.max(...rows.map((r) => (r[i] ?? "").length)),
	);
	const lines = rows.map((r) =>
		r
			.map((c, i) => c.padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd(),
	);
	const out = [
		`tier2 env=${report.meta.env} turn=${report.meta.turn_model} judge=${report.meta.judge_model} samples=${report.meta.samples_per_scenario}`,
		...lines,
	];
	if (report.violations.length > 0) {
		out.push("", "violations:");
		for (const x of report.violations) {
			out.push(
				`- ${x.scenario}: ${x.metric} expected ${x.expected}, observed ${x.observed}`,
			);
		}
	}
	return out.join("\n");
};
