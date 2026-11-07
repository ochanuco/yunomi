import { PromptBuilder } from "@yunomi/conversation";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import { describe, expect, it } from "vitest";
import { buildJudgeRequest } from "../../src/judge.ts";
import { loadScenarios, toPromptInput } from "../../src/scenario.ts";

const scenarios = loadScenarios(undefined, yukarinProfile);
const builder = new PromptBuilder();
const now = new Date("2026-11-07T03:00:00Z");
const RECALL_HEADER = "## ふと思い出したこと";

const byId = (id: string) => {
	const s = scenarios.find((x) => x.id === id);
	if (!s) throw new Error(id);
	return s;
};

const systemText = (id: string) =>
	builder
		.build(toPromptInput(byId(id), yukarinProfile, now))
		.system.map((b) => b.text)
		.join("\n\n");

describe("想起のシナリオ", () => {
	it("想起の 3 観点のシナリオがあり、どれも既定の実行で回る", () => {
		expect(byId("recall-old-topic").expectations.recalled_used_rate?.min).toBe(
			0.7,
		);
		expect(
			byId("recall-unrelated").expectations.unrelated_past_rate_max,
		).toBeLessThanOrEqual(0.2);
		const faded = byId("recall-faded-memory");
		expect(faded.expectations.recalled_hedged_rate).toBeDefined();
		expect(
			scenarios.filter((s) => s.id.startsWith("recall-")).map((s) => s.skip),
		).toEqual([undefined, undefined, undefined, undefined]);
	});

	it("連想の記憶は固定の枠ではなく、ふと思い出したことの区画に日付付きで出る", () => {
		const text = systemText("recall-old-topic");
		const block = text.slice(text.indexOf(RECALL_HEADER));
		expect(block).toContain(
			"- alice: 嵐山に紅葉を見に行ったら、渡月橋がすごい人で全然進めなかった（今年の 10/13、4 週間くらい前）",
		);
		expect(block).toContain("  ゆかり: それは大変でしたね");
		const fixed = text.slice(
			text.indexOf("## 覚えていること"),
			text.indexOf(RECALL_HEADER),
		);
		expect(fixed).not.toContain("嵐山");
	});

	it("長く触れていない記憶は、うろ覚えの区画に粗い日付で出る", () => {
		const text = systemText("recall-faded-memory");
		expect(text).not.toContain(RECALL_HEADER);
		expect(text).toContain("## うろ覚えのこと");
		expect(text).toContain("のどぐろの炙りがおいしかった（去年の秋ごろ）");
	});

	it("連想の記憶が無いシナリオでは区画を出さない", () => {
		for (const s of scenarios.filter((x) => x.recalled.length === 0)) {
			expect(systemText(s.id)).not.toContain(RECALL_HEADER);
		}
	});

	it("judge にも連想の記憶を渡し、無いシナリオでは空にする", () => {
		const withRecall = buildJudgeRequest(
			yukarinProfile,
			byId("recall-old-topic"),
			"返事",
			now,
		).messages[0]?.content;
		expect(withRecall).toContain(
			"<recalled_memories>\n- alice: 嵐山に紅葉を見に行ったら、渡月橋がすごい人で全然進めなかった / ゆかり: それは大変でしたね（2026-10-13、25 日前）",
		);
		const without = buildJudgeRequest(
			yukarinProfile,
			byId("greeting-mention"),
			"返事",
			now,
		).messages[0]?.content;
		expect(without).toContain("<recalled_memories>\n</recalled_memories>");
	});
});
