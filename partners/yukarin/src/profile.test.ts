import { readFileSync } from "node:fs";
import { partnerProfileSchema, toAivoiceValues } from "@yunomi/core";
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
		expect(voice?.engines.aivoice?.preset).toBe("結月 ゆかり");
		if (!voice) throw new Error("voice がない");
		const values = toAivoiceValues(
			{
				emotion: "joy",
				energy: 0.8,
				pace: "normal",
				warmth: 0.5,
				pause_before_ms: 0,
			},
			voice,
		);
		expect(values?.presetOverrides.Styles.map((s) => s.Name).sort()).toEqual([
			"A",
			"J",
			"S",
		]);
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

	it("範囲外の値を拒否する", () => {
		const p = loadProfile();
		const bad = { ...p, initial_state: { mood: 2, energy: 0.5 } };
		expect(v.safeParse(partnerProfileSchema, bad).success).toBe(false);
	});
});
