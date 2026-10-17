import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
	buildGatePrompt,
	GATE_RECENT_LIMIT,
	type GateInput,
	gateDecisionSchema,
	relationshipTier,
} from "./gate-prompt.ts";
import { profile } from "./test-fixtures.ts";

const input = (over: Partial<GateInput> = {}): GateInput => ({
	profile: {
		...profile,
		identity: {
			official: "公式設定の秘密の本文。",
			fanon: "二次設定の秘密の本文。",
			yunomi:
				"# 見出し\n\n丁寧で落ち着いた人格。\n二行目。\n\n## 話し方\n\n後ろの段落。",
		},
	},
	interests: [
		{ topic: "music", label: "音楽", score: 0.55, summary: "歌に耳が向く" },
	],
	recent: [
		{
			speaker: "bob",
			text: "昨日のイベントどうだった？",
			minutesAgo: 5,
			isPartner: false,
			isBot: false,
		},
		{
			speaker: "テスト",
			text: "楽しかったです",
			minutesAgo: 4,
			isPartner: true,
			isBot: false,
		},
	],
	minutesSincePartnerSpoke: 4,
	message: { speaker: "alice", text: "新しいゲーム始めた" },
	headcount: 2,
	state: { mood: 0.3, energy: 0.65, presence: "available" },
	relationship: { familiarity: 0.5, trust: 0.25 },
	...over,
});

const all = (p: ReturnType<typeof buildGatePrompt>) =>
	[...p.system.map((b) => b.text), ...p.messages.map((m) => m.content)].join(
		"\n",
	);

describe("buildGatePrompt", () => {
	it("判定基準・人物紹介・興味・直近ログ・間隔・新しい発言を渡す", () => {
		const p = buildGatePrompt(input());
		const text = all(p);
		expect(text).toContain("迷ったら入らない");
		expect(text).toContain("名前: テスト");
		expect(text).toContain("丁寧で落ち着いた人格。\n二行目。");
		expect(text).toContain("音楽（0.55）: 歌に耳が向く");
		expect(text).toContain("bob（5 分前）: 昨日のイベントどうだった？");
		expect(text).toContain("テスト（あなた）（4 分前）: 楽しかったです");
		expect(text).toContain("最後に話してから 4 分");
		expect(text).toContain("alice: 新しいゲーム始めた");
	});

	it("公式・二次設定、記憶・関係・気分・未解決の話題・意見は渡さない", () => {
		const text = all(buildGatePrompt(input()));
		for (const absent of [
			"秘密の本文",
			"後ろの段落",
			"覚えていること",
			"気分",
			"未解決の話題",
			"意見",
		]) {
			expect(text).not.toContain(absent);
		}
	});

	it("直近ログは末尾 10 件だけ、話していないときはその旨を書く", () => {
		const recent = Array.from({ length: 15 }, (_, i) => ({
			speaker: "bob",
			text: `発言${i}`,
			minutesAgo: 15 - i,
			isPartner: false,
			isBot: false,
		}));
		const p = buildGatePrompt(
			input({ recent, minutesSincePartnerSpoke: null }),
		);
		const content = p.messages[0]?.content ?? "";
		expect(content).not.toContain("発言4\n");
		expect(content).toContain("発言5");
		expect(content.match(/発言\d+/g)).toHaveLength(GATE_RECENT_LIMIT);
		expect(content).toContain("まだ話していない");
	});

	it("前半（基準と人物紹介）は入力が変わっても同じで、cache 対象になる", () => {
		const a = buildGatePrompt(input());
		const b = buildGatePrompt(
			input({
				interests: [],
				recent: [],
				message: { speaker: "x", text: "y" },
			}),
		);
		expect(a.system[0]).toEqual(b.system[0]);
		expect(a.system[0]?.cache).toBe(true);
	});
});

describe("buildGatePrompt の場の情報", () => {
	const user = (over: Partial<GateInput>) =>
		buildGatePrompt(input(over)).messages[0]?.content ?? "";

	it("1 人だけなら 2 人きりと書き、複数なら人数を書く", () => {
		expect(user({ headcount: 1 })).toContain(
			"この場で話している人は alice だけで、あなたと 2 人きり。",
		);
		expect(user({ headcount: 3 })).toContain("この場で話している人は 3 人。");
	});

	it("ゆかりの状態を範囲つきで渡す", () => {
		const c = user({
			state: { mood: -0.2, energy: 0.1, presence: "busy" },
		});
		expect(c).toContain("mood: -0.20（-1 から 1）");
		expect(c).toContain("energy: 0.10（0 から 1）");
		expect(c).toContain("presence: busy");
	});

	it("関係があれば数値を、なければ初めての相手と書く", () => {
		expect(user({})).toContain(
			"alice との関係: 親しい（familiarity 0.50、trust 0.25）",
		);
		const c = user({ relationship: null });
		expect(c).toContain("alice とはまだ関係がない（初めての相手）。");
		expect(c).not.toContain("familiarity");
	});

	it("関係の段階は familiarity と trust の平均で決まる", () => {
		const t = (f: number, tr = f) =>
			relationshipTier({ familiarity: f, trust: tr });
		expect(t(0.19)).toBe("初対面");
		expect(t(0.2)).toBe("顔見知り");
		expect(t(0.35)).toBe("親しい");
		expect(t(0.6)).toBe("とても親しい");
		expect(t(0.31, 0.45)).toBe("親しい");
	});

	it("system の cache 対象ブロックは新しい入力に依存しない", () => {
		const a = buildGatePrompt(input());
		const b = buildGatePrompt(
			input({
				headcount: 1,
				state: { mood: -1, energy: 0, presence: "sleeping" },
				relationship: null,
			}),
		);
		expect(a.system).toEqual(b.system);
	});
});

describe("gateDecisionSchema", () => {
	it("join と reason を要求する", () => {
		expect(
			v.safeParse(gateDecisionSchema, { join: true, reason: "興味の話題" })
				.success,
		).toBe(true);
		expect(v.safeParse(gateDecisionSchema, { join: "yes" }).success).toBe(
			false,
		);
	});
});
