import { readFileSync } from "node:fs";
import {
	EXAMPLE_SCENES,
	partnerProfileSchema,
	toAivoiceValues,
} from "@yunomi/core";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
	computeProfileVersion,
	generatedPath,
	loadProfile,
	renderGenerated,
} from "../scripts/build.ts";
import { profileVersion, yukarinProfile } from "./index.ts";

describe("yukarin profile", () => {
	it("生成物が profile.yaml / identity から最新である", () => {
		expect(readFileSync(generatedPath, "utf8")).toBe(renderGenerated());
	});

	it("プロファイルがスキーマに適合する", () => {
		expect(v.safeParse(partnerProfileSchema, yukarinProfile).success).toBe(
			true,
		);
		expect(yukarinProfile.partner_id).toBe("yukarin");
	});

	it("声の性質が A.I.VOICE の実現方法を持ち、値に変換できる", () => {
		const voice = yukarinProfile.voice;
		if (!voice) throw new Error("voice がない");
		const aivoice = voice.engines.aivoice;
		expect(aivoice?.default).toBe("yukari");
		expect(Object.keys(aivoice?.realizations ?? {}).sort()).toEqual([
			"shizuku",
			"yukari",
		]);
		const ir = {
			emotion: "joy" as const,
			energy: 0.8,
			pace: "normal" as const,
			warmth: 0.5,
			pause_before_ms: 0,
		};
		const yukari = toAivoiceValues(ir, voice, "yukari");
		expect(yukari?.preset).toBe("結月 ゆかり");
		expect(yukari?.presetOverrides.Styles?.map((s) => s.Name).sort()).toEqual([
			"A",
			"J",
			"S",
		]);
		const shizuku = toAivoiceValues(ir, voice, "shizuku");
		expect(shizuku?.preset).toBe("結月 ゆかり（雫）");
		expect(shizuku?.presetOverrides).toEqual({});
	});

	it("版数は内容が変わると変わり、同じ内容なら変わらない", () => {
		const p = loadProfile();
		expect(computeProfileVersion(p)).toBe(profileVersion);
		expect(computeProfileVersion({ ...p })).toBe(profileVersion);
		expect(
			computeProfileVersion({
				...p,
				identity: { ...p.identity, yunomi: `${p.identity.yunomi}!` },
			}),
		).not.toBe(profileVersion);
		expect(
			computeProfileVersion({
				...p,
				speech: { ...p.speech, casualization_limit: 0.9 },
			}),
		).not.toBe(profileVersion);
	});

	it("会話例はどの場面にも 3 件以上ある（親しさで解禁する sulk は 2 件以上）", () => {
		for (const scene of EXAMPLE_SCENES) {
			expect(
				yukarinProfile.examples.filter((x) => x.scene === scene).length,
			).toBeGreaterThanOrEqual(scene === "sulk" ? 2 : 3);
		}
	});

	it("親しさの段階は 0 から始まり昇順で、丁寧語を崩さない", () => {
		const tiers = yukarinProfile.familiarity_tiers ?? [];
		expect(tiers.map((t) => t.min)).toEqual([0, 0.3, 0.6]);
		for (const t of tiers) expect(t.text).toContain("丁寧語は崩さない");
	});

	it("親しさの段階の不正を拒否する", () => {
		const p = loadProfile();
		const tier = (min: number) => ({ min, label: "x", text: "y" });
		const ok = (familiarity_tiers: unknown) =>
			v.safeParse(partnerProfileSchema, { ...p, familiarity_tiers }).success;
		expect(ok([tier(0), tier(0.5)])).toBe(true);
		expect(ok([])).toBe(false);
		expect(ok([tier(0.1), tier(0.5)])).toBe(false);
		expect(ok([tier(0), tier(0.5), tier(0.5)])).toBe(false);
		expect(ok([tier(0), tier(0.6), tier(0.3)])).toBe(false);
		expect(ok([tier(0), tier(1.2)])).toBe(false);
		expect(ok([tier(0), { min: 0.5, label: "x", text: "" }])).toBe(false);
	});

	it("min_familiarity は 0〜1 の範囲だけ受け付ける", () => {
		const p = loadProfile();
		const ex = (min_familiarity: number) => ({
			...p,
			examples: [
				{
					id: "a",
					scene: "sulk",
					min_familiarity,
					turns: [{ speaker: "other", text: "x" }],
				},
			],
		});
		expect(v.safeParse(partnerProfileSchema, ex(0.3)).success).toBe(true);
		expect(v.safeParse(partnerProfileSchema, ex(1.5)).success).toBe(false);
	});

	it("範囲外の値を拒否する", () => {
		const p = loadProfile();
		const bad = { ...p, initial_state: { mood: 2, energy: 0.5 } };
		expect(v.safeParse(partnerProfileSchema, bad).success).toBe(false);
	});
});
