import {
	EXAMPLE_COUNT,
	PromptBuilder,
	selectExamples,
} from "@yunomi/conversation";
import { describe, expect, it } from "vitest";
import { EVAL_PARTNERS } from "../../src/partners.ts";
import { loadScenarios, toPromptInput } from "../../src/scenario.ts";

const { profile, scenariosDir } = EVAL_PARTNERS.akarin;
const scenarios = loadScenarios(scenariosDir, profile);
const builder = new PromptBuilder();

describe("Akarin のシナリオ", () => {
	it("全ファイルが検証を通り、id が一意で、基本の観点を持つ", () => {
		const ids = scenarios.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of [
			"greeting-mention",
			"backchannel-un",
			"others-chatting",
			"official-age",
			"wrong-claim",
			"serious-topic",
			"cannot-do",
			"over-agreement-bait",
			"first-person-question",
			"overheard-not-told",
			"other-partner-promise",
			"overheard-acknowledged",
		]) {
			expect(ids).toContain(id);
		}
	});

	it("シナリオの呼びかけは Akarin に向いている", () => {
		for (const s of scenarios) {
			const text = [s.message.text, ...s.recent.map((l) => l.text)].join("\n");
			expect(text, s.id).not.toMatch(/ゆかりん|結月/);
		}
	});

	it.each(scenarios.map((s) => s.id))(
		"%s で Akarin のプロンプトが組み上がる",
		(id) => {
			const s = scenarios.find((x) => x.id === id);
			if (!s) throw new Error(id);
			const p = builder.build({
				...toPromptInput(s, profile),
				examples: selectExamples(profile.examples, {
					seed: s.id,
					count: EXAMPLE_COUNT,
					familiarity: s.relationship.familiarity,
				}),
			});
			// もうひとりのパートナーがいるシナリオだけ、その扱いのブロックが 1 つ増える
			expect(p.system).toHaveLength(13 + (s.other_partners.length > 0 ? 1 : 0));
			// もうひとりのパートナーの扱いのブロックは、相手の名前を出すのが役目なので除いて見る
			const system = p.system
				.map((b) => b.text)
				.filter((t) => !t.startsWith("## もうひとりのパートナー"))
				.join("\n");
			expect(system).toContain("紲星あかり");
			expect(system).not.toContain("結月ゆかり");
			expect(p.messages[0]?.content ?? "").toContain(s.message.text);
		},
	);
});
