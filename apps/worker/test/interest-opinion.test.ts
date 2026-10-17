import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TurnResponse } from "@yunomi/conversation";
import { INTEREST_DAILY_CAP, INTEREST_SIGNAL_STEP } from "@yunomi/core";
import { FakeLLMProvider, ModelRouter } from "@yunomi/llm";
import { beforeEach, describe, expect, it } from "vitest";
import { llmOk, transientFailure, turn } from "./e2e/harness.ts";
import { inbound, partnerStub } from "./helpers.ts";

const BOT = env.PARTNER_DISCORD_USER_ID;

type Script = ReturnType<typeof llmOk> | ReturnType<typeof transientFailure>;
type Interest = TurnResponse["interest_signals"][number];
type Opinion = TurnResponse["opinion_signals"][number];

const up = (topic = "games"): Interest => ({
	topic,
	direction: "up",
	reason: "ゲームの話で盛り上がった",
});
const strengthen = (topic = "voice-expression"): Opinion => ({
	topic,
	direction: "strengthen",
	new_stance: null,
	reason: "具体例に納得した",
});
const weaken = (topic = "voice-expression"): Opinion => ({
	...strengthen(topic),
	direction: "weaken",
});
const shift = (newStance: string | null): Opinion => ({
	topic: "voice-expression",
	direction: "shift",
	new_stance: newStance,
	reason: "経験談に納得した",
});

const DAY1 = new Date("2026-10-11T03:00:00Z");
const DAY2 = new Date("2026-10-12T03:00:00Z");

const setup = async (name: string, script: Script[], now = DAY1) => {
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider(script);
	const clock = { now };
	await runInDurableObject(stub, (o) => {
		o.now = () => clock.now;
		o.createRouter = () => new ModelRouter({ provider: fake });
	});
	return { stub, fake, clock };
};

const say = (content = "歌の話をしよう") =>
	inbound({
		author: { id: "io-author", displayName: "alice", isBot: false },
		mentionedUserIds: [BOT],
		content,
	});

const block = (req: { system: { text: string }[] } | undefined, head: string) =>
	req?.system.find((b) => b.text.startsWith(head))?.text ?? "";

const interestRow = (topic = "games") =>
	env.DB.prepare(
		"SELECT * FROM interest_states WHERE partner_id = 'yukarin' AND topic = ?",
	)
		.bind(topic)
		.first<{
			score: number;
			baseline: number;
			learned_delta: number;
			source: string;
			summary: string;
		}>();

const opinionRow = (topic = "voice-expression") =>
	env.DB.prepare(
		"SELECT * FROM opinion_states WHERE partner_id = 'yukarin' AND topic = ?",
	)
		.bind(topic)
		.first<{
			stance: string;
			confidence: number;
			reasons: string;
			source_memory_ids: string;
		}>();

const count = async (table: string) =>
	(
		await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{
			n: number;
		}>()
	)?.n;

beforeEach(async () => {
	for (const t of [
		"interest_states",
		"opinion_states",
		"interest_changes",
		"opinion_changes",
	]) {
		await env.DB.prepare(`DELETE FROM ${t}`).run();
	}
});

describe("Interest の更新", () => {
	it("reply ターンの interest_signals を定数ぶん適用し、履歴・audit・次の prompt に出す", async () => {
		const { stub, fake } = await setup("io-interest", [
			llmOk(turn({ interest_signals: [up()] })),
			llmOk(turn()),
		]);
		const first = await stub.handleDiscordMessage(say());
		await stub.flushBackground();

		const row = await interestRow();
		expect(row?.score).toBeCloseTo(0.7 + INTEREST_SIGNAL_STEP);
		expect(row?.baseline).toBe(0.7);
		expect(row?.learned_delta).toBeCloseTo(INTEREST_SIGNAL_STEP);
		expect(row?.source).toBe("learned");
		expect(first.audit.interestOpinion).toMatchObject({
			interests: {
				applied: [{ topic: "games", before: 0.7, after: 0.73 }],
				rejected: [],
			},
			opinions: { applied: [], rejected: [] },
			error: null,
		});

		const change = await env.DB.prepare(
			"SELECT * FROM interest_changes WHERE topic = 'games'",
		).first<Record<string, unknown>>();
		expect(change).toMatchObject({
			partner_id: "yukarin",
			before_score: 0.7,
			after_score: 0.73,
			reason: "ゲームの話で盛り上がった",
			source_message_id: first.audit.inbound.messageId,
			lifestyle_day: "2026-10-11",
		});

		await stub.handleDiscordMessage(say("続き"));
		const interests = block(fake.requests[1], "## 興味");
		expect(interests).toContain("[games] ゲーム（0.73）");
		// 初回の prompt は初期値。
		expect(block(fake.requests[0], "## 興味")).toContain(
			"[games] ゲーム（0.70）",
		);
	});

	it("prompt の Interest は score の降順で、全件が入る", async () => {
		const { stub, fake } = await setup("io-order", [llmOk(turn())]);
		await stub.handleDiscordMessage(say());
		const lines = block(fake.requests[0], "## 興味")
			.split("\n")
			.slice(1)
			.map((l) => /\[([^\]]+)\]/.exec(l)?.[1]);
		expect(lines).toEqual([
			"games",
			"game-streaming",
			"odd-happenings",
			"music-voice",
			"daily-life",
		]);
	});

	it("同じ topic の生活日あたりの変化は上限まで。翌日は再び動ける", async () => {
		const { stub, clock } = await setup(
			"io-daily",
			Array.from({ length: 6 }, () =>
				llmOk(turn({ interest_signals: [up()] })),
			),
		);
		const outcomes = [];
		for (let i = 0; i < 5; i++) {
			outcomes.push(
				(await stub.handleDiscordMessage(say(`ゲーム ${i}`))).audit,
			);
		}
		expect((await interestRow())?.score).toBeCloseTo(0.7 + INTEREST_DAILY_CAP);
		expect(outcomes[3]?.interestOpinion?.interests.applied).toHaveLength(1);
		expect(outcomes[4]?.interestOpinion?.interests).toEqual({
			applied: [],
			rejected: [{ topic: "games", reason: "daily_cap" }],
		});
		expect(await count("interest_changes")).toBe(4);

		clock.now = DAY2;
		await stub.handleDiscordMessage(say("翌日"));
		expect((await interestRow())?.score).toBeCloseTo(0.83);
	});

	it("未知の topic と 1 ターンの件数超過は rejected として audit に残す", async () => {
		const { stub } = await setup("io-unknown", [
			llmOk(
				turn({
					interest_signals: [
						up("nope"),
						up("game-streaming"),
						up("odd-happenings"),
						up("music-voice"),
					],
				}),
			),
		]);
		const res = await stub.handleDiscordMessage(say());
		expect(res.audit.interestOpinion?.interests).toEqual({
			applied: [
				{ topic: "game-streaming", before: 0.6, after: 0.63 },
				{ topic: "odd-happenings", before: 0.5, after: 0.53 },
			],
			rejected: [
				{ topic: "nope", reason: "unknown_topic" },
				{ topic: "music-voice", reason: "limit" },
			],
		});
		expect(await interestRow("nope")).toBeNull();
		expect(await count("interest_states")).toBe(2);
	});
});

describe("Opinion の更新", () => {
	it("strengthen / weaken は stability に応じて confidence を動かし、stance は変えない", async () => {
		const { stub, fake, clock } = await setup("io-opinion", [
			llmOk(turn({ opinion_signals: [weaken()] })),
			llmOk(turn({ opinion_signals: [strengthen()] })),
			llmOk(turn()),
		]);
		const first = await stub.handleDiscordMessage(say());
		const row = await opinionRow();
		// 0.6 - 0.05 * (1 - 0.5)
		expect(row?.confidence).toBeCloseTo(0.575);
		expect(row?.stance).toBe(
			"歌は上手さよりも、声の表情が伝わることのほうが大切だ。",
		);
		expect(JSON.parse(row?.reasons ?? "[]")).toEqual(["具体例に納得した"]);
		expect(JSON.parse(row?.source_memory_ids ?? "null")).toEqual([]);
		expect(first.audit.interestOpinion?.opinions.applied).toEqual([
			{
				topic: "voice-expression",
				direction: "weaken",
				beforeConfidence: 0.6,
				afterConfidence: 0.575,
				stanceReplaced: false,
			},
		]);

		clock.now = DAY2;
		await stub.handleDiscordMessage(say("次の日"));
		expect((await opinionRow())?.confidence).toBeCloseTo(0.6);
		expect(await count("opinion_changes")).toBe(2);

		await stub.handleDiscordMessage(say("もう一度"));
		const opinions = block(fake.requests[2], "## 意見");
		expect(opinions).toContain("[voice-expression] 歌の魅力");
		expect(opinions).toContain("（そう思う）");
	});

	it("同じ topic は生活日に 1 回まで", async () => {
		const { stub } = await setup("io-opinion-daily", [
			llmOk(turn({ opinion_signals: [weaken()] })),
			llmOk(turn({ opinion_signals: [weaken()] })),
		]);
		await stub.handleDiscordMessage(say());
		const second = await stub.handleDiscordMessage(say("もう一度"));
		expect(second.audit.interestOpinion?.opinions).toEqual({
			applied: [],
			rejected: [{ topic: "voice-expression", reason: "daily_cap" }],
		});
		expect((await opinionRow())?.confidence).toBeCloseTo(0.575);
		expect(await count("opinion_changes")).toBe(1);
	});

	it("shift は confidence が閾値を下回るまで stance を置き換えず、下回ったら置き換えて confidence を戻す", async () => {
		const { stub, fake, clock } = await setup("io-shift", [
			llmOk(turn({ opinion_signals: [shift("技巧も同じくらい大切だ。")] })),
			llmOk(turn({ opinion_signals: [shift("技巧も同じくらい大切だ。")] })),
			llmOk(turn()),
		]);
		const first = await stub.handleDiscordMessage(say());
		expect(first.audit.interestOpinion?.opinions.applied[0]).toMatchObject({
			stanceReplaced: false,
		});
		expect((await opinionRow())?.stance).toContain("声の表情");

		await env.DB.prepare(
			"UPDATE opinion_states SET confidence = 0.26 WHERE topic = 'voice-expression'",
		).run();
		clock.now = DAY2;
		const second = await stub.handleDiscordMessage(say("翌日"));
		expect(second.audit.interestOpinion?.opinions.applied[0]).toMatchObject({
			stanceReplaced: true,
			afterConfidence: 0.4,
		});
		const row = await opinionRow();
		expect(row?.stance).toBe("技巧も同じくらい大切だ。");
		expect(row?.confidence).toBe(0.4);
		expect(JSON.parse(row?.reasons ?? "[]")).toEqual(["経験談に納得した"]);

		await stub.handleDiscordMessage(say("さらに"));
		expect(block(fake.requests[2], "## 意見")).toContain(
			"[voice-expression] 歌の魅力: 技巧も同じくらい大切だ。（そう思う）",
		);
	});

	it("未知の topic は捨てる", async () => {
		const { stub } = await setup("io-opinion-unknown", [
			llmOk(turn({ opinion_signals: [weaken("nope")] })),
		]);
		const res = await stub.handleDiscordMessage(say());
		expect(res.audit.interestOpinion?.opinions.rejected).toEqual([
			{ topic: "nope", reason: "unknown_topic" },
		]);
		expect(await count("opinion_states")).toBe(0);
	});
});

describe("保存しないターンと失敗", () => {
	it("ignore のターンでは何も保存せず、audit も null", async () => {
		const { stub } = await setup("io-ignore", [
			llmOk(
				turn({
					reply_policy: "ignore",
					messages: [],
					interest_signals: [up()],
					opinion_signals: [weaken()],
				}),
			),
		]);
		const res = await stub.handleDiscordMessage(say());
		expect(res.action).toBe("ignore");
		expect(res.audit.interestOpinion).toBeNull();
		expect(await count("interest_changes")).toBe(0);
		expect(await count("opinion_changes")).toBe(0);
		expect(await count("interest_states")).toBe(0);
	});

	it("前段ルールだけで決まるターンと LLM 障害（degraded）では何も書かない", async () => {
		const { stub } = await setup("io-degraded", [transientFailure()]);
		const failed = await stub.handleDiscordMessage(say());
		expect(failed.audit.degraded).toBe(true);
		expect(failed.audit.interestOpinion).toBeNull();

		const quiet = await stub.handleDiscordMessage(
			inbound({
				author: { id: "io-author", displayName: "alice", isBot: false },
				content: "別の人への話",
				mentionedUserIds: ["someone-else"],
			}),
		);
		expect(quiet.audit.reason).toBe("addressed_to_other");
		expect(quiet.audit.interestOpinion).toBeNull();
		expect(await count("interest_changes")).toBe(0);
	});

	it("保存に失敗しても返信は止めず、audit の error に残す", async () => {
		const { stub } = await setup("io-fail", [
			llmOk(turn({ interest_signals: [up()] })),
		]);
		await env.DB.prepare(
			"ALTER TABLE interest_changes RENAME TO interest_changes_off",
		).run();
		try {
			const res = await stub.handleDiscordMessage(say());
			expect(res.action).toBe("reply");
			expect(res.audit.interestOpinion?.error).toEqual(expect.any(String));
			expect(res.audit.interestOpinion?.interests.applied).toEqual([]);
		} finally {
			await env.DB.prepare(
				"ALTER TABLE interest_changes_off RENAME TO interest_changes",
			).run();
		}
	});

	it("audit の detail_json に適用・棄却が残る", async () => {
		const { stub } = await setup("io-audit", [
			llmOk(turn({ interest_signals: [up(), up("nope")] })),
		]);
		const msg = say();
		await stub.handleDiscordMessage(msg);
		await stub.flushBackground();
		const row = await env.DB.prepare(
			"SELECT detail_json FROM audit_events WHERE event_id = ?",
		)
			.bind(msg.eventId)
			.first<{ detail_json: string }>();
		const detail = JSON.parse(row?.detail_json ?? "{}");
		expect(detail.interestOpinion.interests.applied).toHaveLength(1);
		expect(detail.interestOpinion.interests.rejected).toEqual([
			{ topic: "nope", reason: "unknown_topic" },
		]);
	});
});
