import { readFileSync } from "node:fs";
import { partnerProfileSchema } from "@yunomi/core";
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
