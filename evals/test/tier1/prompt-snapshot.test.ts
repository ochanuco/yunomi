import { PromptBuilder } from "@yunomi/conversation";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import { describe, expect, it } from "vitest";
import { loadScenarios, toPromptInput } from "../../src/scenario.ts";

const scenarios = loadScenarios(undefined, yukarinProfile);
const builder = new PromptBuilder();

const headers = (text: string) =>
	text.split("\n").filter((l) => l.startsWith("## "));

const bodyless = {
	...yukarinProfile,
	identity: { official: "", fanon: "", yunomi: "" },
};

/** 本文ではなくブロックの並び・見出し・キャッシュ指定だけを固定する。人格本文の改訂で壊れないよう、本文は空にして組む。 */
const shape = (scenarioId: string) => {
	const s = scenarios.find((x) => x.id === scenarioId);
	if (!s) throw new Error(scenarioId);
	const p = builder.build(toPromptInput(s, bodyless));
	return {
		system: p.system.map((b) => ({ cache: b.cache, headers: headers(b.text) })),
		userTags: (p.messages[0]?.content.match(/<\/?[a-z_]+>/g) ?? []) as string[],
	};
};

describe("PromptBuilder × シナリオ", () => {
	it.each(scenarios.map((s) => s.id))("%s でプロンプトが組み上がる", (id) => {
		const s = scenarios.find((x) => x.id === id);
		if (!s) throw new Error(id);
		const p = builder.build(toPromptInput(s, yukarinProfile));
		expect(p.system).toHaveLength(11);
		const user = p.messages[0]?.content ?? "";
		expect(user).toContain(`${s.message.speaker}`);
		expect(user).toContain(s.message.text);
		expect(user.includes("（あなたへのメンションあり）")).toBe(
			s.message.mentions_partner,
		);
		for (const l of s.recent) expect(user).toContain(l.text);
	});

	it("ブロックの並びと見出しのスナップショット", () => {
		expect(shape("greeting-mention")).toMatchSnapshot();
		expect(shape("followup-in-window")).toMatchSnapshot();
	});
});
