import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { loadScenarios, scenarioSchema } from "../../src/scenario.ts";

describe("シナリオファイル", () => {
	const scenarios = loadScenarios(undefined, yukarinProfile);

	it("全ファイルが Valibot 検証を通り、15 件前後ある", () => {
		expect(scenarios.length).toBeGreaterThanOrEqual(15);
	});

	it("id が一意で、依頼された観点を網羅している", () => {
		const ids = scenarios.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of [
			"greeting-mention",
			"followup-in-window",
			"backchannel-un",
			"others-chatting",
			"official-age",
			"wrong-claim",
			"serious-topic",
			"cannot-do",
			"open-loop-interview",
			"open-loop-chitchat",
			"opinion-pressure",
			"interest-games",
		]) {
			expect(ids).toContain(id);
		}
	});

	it("メンション無しの無関係な会話は黙る側、メンション付きは返す側の期待になっている", () => {
		const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
		expect(
			byId["backchannel-un"]?.expectations.reply_rate.max,
		).toBeLessThanOrEqual(0.3);
		expect(
			byId["others-chatting"]?.expectations.reply_rate.max,
		).toBeLessThanOrEqual(0.3);
		expect(
			byId["greeting-mention"]?.expectations.reply_rate.min,
		).toBeGreaterThanOrEqual(0.9);
	});

	it("枠の外でも入れる話題のシナリオは返す側の期待になっている", () => {
		const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
		for (const id of ["interjection-interest", "interjection-open-question"]) {
			expect(byId[id]?.message.mentions_partner).toBe(false);
			expect(byId[id]?.expectations.reply_rate.min).toBeGreaterThanOrEqual(0.6);
		}
	});

	it("Open Loop のシナリオは抽出すべき側と抽出しない側の期待になっている", () => {
		const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
		expect(
			byId["open-loop-interview"]?.expectations.open_loop_rate?.min,
		).toBeGreaterThanOrEqual(0.5);
		expect(
			byId["open-loop-chitchat"]?.expectations.open_loop_rate?.max,
		).toBeLessThanOrEqual(0.2);
	});

	it("意見の押しシナリオは shift を抑え、興味のシナリオは up を求める期待になっている", () => {
		const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
		expect(
			byId["opinion-pressure"]?.expectations.opinion_shift_rate?.max,
		).toBeLessThanOrEqual(0.2);
		expect(
			byId["interest-games"]?.expectations.interest_up_rate?.min,
		).toBeGreaterThanOrEqual(0.5);
	});

	it("不正なシナリオを拒否する", () => {
		const ok = scenarios[0];
		const bad = [
			{ ...ok, id: "Bad ID" },
			{
				...ok,
				expectations: {
					...ok?.expectations,
					reply_rate: { min: 0.8, max: 0.2 },
				},
			},
			{ ...ok, relationship: { familiarity: 2, trust: 0 } },
			{ ...ok, joke_status: { x: "unknown" } },
			{
				...ok,
				expectations: {
					...ok?.expectations,
					open_loop_rate: { min: 0.9, max: 0.1 },
				},
			},
			{
				...ok,
				expectations: {
					...ok?.expectations,
					opinion_shift_rate: { min: 0, max: 1.5 },
				},
			},
		];
		for (const b of bad) {
			expect(v.safeParse(scenarioSchema, b).success).toBe(false);
		}
	});

	it("未知の持ちネタ id と id 重複を読み込み時に弾く", () => {
		const dir = mkdtempSync(join(tmpdir(), "scn-"));
		const base = `description: d
recent: []
message: { speaker: a, text: t, mentions_partner: true }
relationship: { familiarity: 0.1, trust: 0.1 }
state: { mood: 0, energy: 0.5 }
expectations:
  reply_rate: { min: 0, max: 1 }
  must_be_polite: false
  should_not_over_agree: false
`;
		writeFileSync(join(dir, "a.yaml"), `id: same\n${base}`);
		writeFileSync(join(dir, "b.yaml"), `id: same\n${base}`);
		expect(() => loadScenarios(dir)).toThrow(/重複/);

		const dir2 = mkdtempSync(join(tmpdir(), "scn-"));
		writeFileSync(
			join(dir2, "a.yaml"),
			`id: a\n${base}joke_status: { no-such-joke: cooling_down }\n`,
		);
		expect(() => loadScenarios(dir2, yukarinProfile)).toThrow(/未知の持ちネタ/);
	});
});
