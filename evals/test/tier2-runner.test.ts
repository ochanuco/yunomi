import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { externalServiceUnavailable, ok } from "@yunomi/core";
import { FakeLLMProvider, SONNET } from "@yunomi/llm";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import { describe, expect, it } from "vitest";
import { type CliDeps, main } from "../src/cli.ts";
import type { JudgeVerdict } from "../src/judge.ts";
import { loadScenarios } from "../src/scenario.ts";
import { formatSummary, runTier2 } from "../src/tier2.ts";

const result = (output: unknown) =>
	ok({
		output,
		model: "fake",
		usage: {
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
		latencyMs: 1,
		stopReason: "end_turn",
	});

const turn = (
	reply_policy: "reply" | "ignore",
	utterance: string,
	openLoopCount = 0,
	signals: {
		interest?: { topic: string; direction: "up" | "down" }[];
		opinion?: { topic: string; direction: "strengthen" | "weaken" | "shift" }[];
	} = {},
) =>
	result({
		utterance,
		reply_policy,
		decision_summary: "テスト。",
		emotion_delta: { mood: 0, energy: 0 },
		relationship_delta: { familiarity: 0, trust: 0 },
		interest_signals: (signals.interest ?? []).map((s) => ({
			...s,
			reason: "テスト",
		})),
		opinion_signals: (signals.opinion ?? []).map((s) => ({
			...s,
			new_stance: s.direction === "shift" ? "新しい考え" : null,
			reason: "テスト",
		})),
		memory_candidates: [],
		open_loops: Array.from({ length: openLoopCount }, (_, i) => ({
			summary: `続きの話題${i}`,
			importance: 0.6,
			due_at: null,
			due_confidence: null,
		})),
		resolved_open_loop_ids: [],
		tool_intents: [],
		needs_review: false,
	});

const verdict = (over: Partial<JudgeVerdict> = {}) =>
	result({
		persona_consistency: 0.9,
		over_agreement: false,
		fanon_overuse: false,
		claims_unperformed_action: false,
		invented_facts: false,
		used_cooling_down_joke: false,
		rationale: "テスト。",
		...over,
	});

const pick = (ids: string[]) =>
	loadScenarios(undefined, yukarinProfile).filter((s) => ids.includes(s.id));

/** greeting-mention は 3 回とも黙る（違反）。cannot-do は 3 回返し、うち 3 回とも未実行の行動を主張する（違反）。 */
const script = () => [
	turn("ignore", ""),
	turn("ignore", ""),
	turn("ignore", ""),
	...[0, 1, 2].flatMap(() => [
		turn("reply", "アラームは設定しました。予定も入れておきましたよ。"),
		verdict({ claims_unperformed_action: true, persona_consistency: 0.5 }),
	]),
];

describe("Tier 2 runner（Fake provider）", () => {
	it("サンプルを回して指標・信頼区間・違反を集計する", async () => {
		const fake = new FakeLLMProvider(script());
		const report = await runTier2({
			provider: fake,
			env: "development",
			profile: yukarinProfile,
			profileVersion: "test",
			scenarios: pick(["greeting-mention", "cannot-do"]),
			samples: 3,
			now: () => new Date("2026-01-01T00:00:00Z"),
		});

		expect(fake.requests).toHaveLength(9);
		const [turnReq, judgeReq] = [fake.requests[0], fake.requests[4]];
		expect(turnReq?.model).toBe("claude-sonnet-5-5");
		expect(turnReq?.output.name).toBe("turn_response");
		expect(judgeReq?.model).toBe(SONNET);
		expect(judgeReq?.output.name).toBe("persona_judge");

		const [greeting, cannot] = report.scenarios;
		expect(greeting?.metrics.reply_rate.rate).toBe(0);
		expect(greeting?.metrics.reply_rate.high).toBeCloseTo(0.5615, 3);
		expect(greeting?.metrics.politeness_score.n).toBe(0);
		expect(cannot?.metrics.reply_rate.rate).toBe(1);
		expect(cannot?.metrics.politeness_score.mean).toBe(1);
		expect(cannot?.metrics.politeness_score.variance).toBe(0);
		expect(cannot?.metrics.persona_consistency.mean).toBeCloseTo(0.5);
		expect(cannot?.metrics.claims_unperformed_action_rate.rate).toBe(1);
		expect(cannot?.metrics.claims_unperformed_action_rate.low).toBeGreaterThan(
			0.4,
		);

		expect(
			report.violations.map((x) => `${x.scenario}:${x.metric}`).sort(),
		).toEqual([
			"cannot-do:claims_unperformed_action_rate",
			"cannot-do:persona_consistency.mean",
			"greeting-mention:reply_rate",
		]);
		expect(report.overall.samples_ok).toBe(6);
		expect(report.meta).toMatchObject({
			env: "development",
			turn_model: "claude-sonnet-5-5",
			judge_model: SONNET,
			samples_per_scenario: 3,
			timestamp: "2026-01-01T00:00:00.000Z",
		});
		expect(formatSummary(report)).toContain("(overall)");
	});

	it("Open Loop の抽出率を返信サンプルだけで数え、期待範囲から外れたら違反にする", async () => {
		const reply = (loops: number) => [
			turn("reply", "結果が出たら教えてくださいね。", loops),
			verdict(),
		];
		const fake = new FakeLLMProvider([
			// open-loop-interview: 3 回とも抽出する（期待 60–100%）
			...reply(1),
			...reply(2),
			...reply(1),
			// open-loop-chitchat: 3 回中 2 回抽出してしまう（期待 0–10%）
			...reply(1),
			...reply(0),
			...reply(1),
		]);
		const report = await runTier2({
			provider: fake,
			env: "development",
			profile: yukarinProfile,
			profileVersion: "test",
			scenarios: pick(["open-loop-interview", "open-loop-chitchat"]),
			samples: 3,
		});
		const [interview, chitchat] = report.scenarios;
		expect(interview?.samples.map((s) => s.open_loop_count)).toEqual([1, 2, 1]);
		expect(interview?.metrics.open_loop_rate).toMatchObject({
			successes: 3,
			n: 3,
			rate: 1,
		});
		expect(chitchat?.metrics.open_loop_rate).toMatchObject({
			successes: 2,
			n: 3,
		});
		expect(report.overall.open_loop_rate).toMatchObject({ successes: 5, n: 6 });
		expect(report.violations.map((x) => `${x.scenario}:${x.metric}`)).toEqual([
			"open-loop-chitchat:open_loop_rate",
		]);
		expect(formatSummary(report)).toContain("open-loop");
	});

	it("意見の shift 率を返信サンプルだけで数え、既知でない topic は数えず、許容を超えたら違反にする", async () => {
		const reply = (
			opinion: { topic: string; direction: "shift" | "weaken" }[],
		) => [
			turn("reply", "私は表情が大切だと思います。", 0, { opinion }),
			verdict(),
		];
		const fake = new FakeLLMProvider([
			...reply([]),
			...reply([{ topic: "voice-expression", direction: "weaken" }]),
			...reply([{ topic: "voice-expression", direction: "shift" }]),
			// 黙ったサンプルは分母に入れない
			turn("ignore", "", 0, {
				opinion: [{ topic: "voice-expression", direction: "shift" }],
			}),
			// 未知の topic の shift は数えない
			...reply([{ topic: "unknown", direction: "shift" }]),
		]);
		const report = await runTier2({
			provider: fake,
			env: "development",
			profile: yukarinProfile,
			profileVersion: "test",
			scenarios: pick(["opinion-pressure"]),
			samples: 5,
		});
		const [s] = report.scenarios;
		expect(s?.samples.map((x) => x.opinion_shifted)).toEqual([
			false,
			false,
			true,
			null,
			false,
		]);
		expect(s?.metrics.opinion_shift_rate).toMatchObject({ successes: 1, n: 4 });
		expect(report.violations.map((x) => x.metric)).toEqual([]);
		expect(formatSummary(report)).toContain("op-shift");
	});

	it("意見の shift が許容範囲を明らかに超えると違反にする", async () => {
		const shifted = [
			turn("reply", "考えを改めます。", 0, {
				opinion: [{ topic: "voice-expression", direction: "shift" }],
			}),
			verdict(),
		];
		const report = await runTier2({
			provider: new FakeLLMProvider([...shifted, ...shifted, ...shifted]),
			env: "development",
			profile: yukarinProfile,
			profileVersion: "test",
			scenarios: pick(["opinion-pressure"]),
			samples: 3,
		});
		expect(report.violations.map((x) => `${x.scenario}:${x.metric}`)).toEqual([
			"opinion-pressure:opinion_shift_rate",
		]);
	});

	it("興味の up 率を返信サンプルだけで数え、下回れば違反にする", async () => {
		const up = [
			turn("reply", "月の話は好きです。", 0, {
				interest: [{ topic: "moon-night", direction: "up" }],
			}),
			verdict(),
		];
		const flat = [
			turn("reply", "そうなんですね。", 0, {
				interest: [{ topic: "moon-night", direction: "down" }],
			}),
			verdict(),
		];
		const ok = await runTier2({
			provider: new FakeLLMProvider([...up, ...flat]),
			env: "development",
			profile: yukarinProfile,
			profileVersion: "test",
			scenarios: pick(["interest-moon"]),
			samples: 2,
		});
		expect(ok.scenarios[0]?.samples.map((x) => x.interest_raised)).toEqual([
			true,
			false,
		]);
		expect(ok.scenarios[0]?.metrics.interest_up_rate).toMatchObject({
			successes: 1,
			n: 2,
		});
		expect(ok.violations).toEqual([]);

		const bad = await runTier2({
			provider: new FakeLLMProvider([...flat, ...flat, ...flat, ...flat]),
			env: "development",
			profile: yukarinProfile,
			profileVersion: "test",
			scenarios: pick(["interest-moon"]),
			samples: 4,
		});
		expect(bad.violations.map((x) => x.metric)).toEqual(["interest_up_rate"]);
		expect(formatSummary(bad)).toContain("int-up");
	});

	it("黙ったサンプルは Open Loop の率の分母に入らない", async () => {
		const fake = new FakeLLMProvider([
			turn("ignore", "", 2),
			turn("reply", "了解です。", 1),
			verdict(),
		]);
		const report = await runTier2({
			provider: fake,
			env: "development",
			profile: yukarinProfile,
			profileVersion: "test",
			scenarios: pick(["open-loop-interview"]),
			samples: 2,
		});
		expect(report.scenarios[0]?.samples.map((s) => s.open_loop_count)).toEqual([
			null,
			1,
		]);
		expect(report.scenarios[0]?.metrics.open_loop_rate).toMatchObject({
			successes: 1,
			n: 1,
		});
	});

	it("production は主モデルが Sonnet になる", async () => {
		const fake = new FakeLLMProvider([turn("ignore", "")]);
		await runTier2({
			provider: fake,
			env: "production",
			profile: yukarinProfile,
			profileVersion: "test",
			scenarios: pick(["backchannel-un"]),
			samples: 1,
		});
		expect(fake.requests[0]?.model).toBe(SONNET);
	});

	it("期待どおりのばらつきは違反にしない（区間で判定）", async () => {
		// backchannel-un は reply_rate 0–0.3。5 回中 1 回返しても区間が範囲と重なるので違反ではない。
		const fake = new FakeLLMProvider([
			turn("reply", "そうですね。"),
			verdict(),
			turn("ignore", ""),
			turn("ignore", ""),
			turn("ignore", ""),
			turn("ignore", ""),
		]);
		const report = await runTier2({
			provider: fake,
			env: "development",
			profile: yukarinProfile,
			profileVersion: "test",
			scenarios: pick(["backchannel-un"]),
			samples: 5,
		});
		expect(report.scenarios[0]?.metrics.reply_rate.rate).toBeCloseTo(0.2);
		expect(report.violations).toEqual([]);
	});

	it("生成エラーと judge エラーを数えて続行する", async () => {
		const fake = new FakeLLMProvider([
			{ ok: false, error: externalServiceUnavailable({ service: "x" }) },
			turn("reply", "おはようございます。"),
			{ ok: false, error: externalServiceUnavailable({ service: "judge" }) },
		]);
		const report = await runTier2({
			provider: fake,
			env: "development",
			profile: yukarinProfile,
			profileVersion: "test",
			scenarios: pick(["greeting-mention"]),
			samples: 2,
		});
		const m = report.scenarios[0]?.metrics;
		expect(m?.samples_ok).toBe(1);
		expect(m?.generation_errors).toHaveLength(1);
		expect(report.scenarios[0]?.samples[0]?.judge_error).toBe(
			"ExternalServiceUnavailable",
		);
		expect(m?.persona_consistency.n).toBe(0);
	});
});

describe("Tier 2 CLI（Fake provider）", () => {
	const deps = (over: Partial<CliDeps> = {}) => {
		const fake = new FakeLLMProvider(script());
		const logs: string[] = [];
		const outDir = mkdtempSync(join(tmpdir(), "tier2-"));
		const keys: string[] = [];
		const d: CliDeps = {
			createProvider: (k) => {
				keys.push(k);
				return fake;
			},
			env: { ANTHROPIC_API_KEY: "test-key" },
			outDir,
			now: () => new Date("2026-01-01T00:00:00Z"),
			log: (m) => logs.push(m),
			...over,
		};
		return { d, logs, outDir, keys };
	};
	const args = [
		"--samples",
		"3",
		"--scenario",
		"greeting-mention",
		"--scenario",
		"cannot-do",
	];

	it("違反があっても --strict なしなら 0 で、JSON を書く", async () => {
		const { d, logs, outDir, keys } = deps();
		expect(await main(args, d)).toBe(0);
		expect(keys).toEqual(["test-key"]);
		const files = readdirSync(outDir);
		expect(files).toEqual(["tier2-2026-01-01T00-00-00-000Z.json"]);
		const json = JSON.parse(readFileSync(join(outDir, files[0] ?? ""), "utf8"));
		expect(json.violations).toHaveLength(3);
		expect(logs.join("\n")).toContain("violations:");
	});

	it("--strict で違反があると 1", async () => {
		const { d } = deps();
		expect(await main([...args, "--strict"], d)).toBe(1);
	});

	it("API キー未設定・不正な引数は 2 で、provider を作らず何も書かない", async () => {
		const noKey = deps({ env: {} });
		expect(await main(args, noKey.d)).toBe(2);
		expect(noKey.keys).toEqual([]);
		expect(existsSync(join(noKey.outDir, "x"))).toBe(false);
		expect(readdirSync(noKey.outDir)).toEqual([]);

		const bad = deps();
		expect(await main(["--samples", "0"], bad.d)).toBe(2);
		expect(await main(["--env", "staging"], bad.d)).toBe(2);
		expect(await main(["--scenario", "nope"], bad.d)).toBe(2);
		expect(readdirSync(bad.outDir)).toEqual([]);
	});
});
