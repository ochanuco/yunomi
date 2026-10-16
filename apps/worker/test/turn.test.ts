import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { GateDecision, TurnResponse } from "@yunomi/conversation";
import {
	type DomainError,
	externalServiceUnavailable,
	validationFailed,
} from "@yunomi/core";
import {
	FakeLLMProvider,
	HAIKU,
	type LLMResult,
	ModelRouter,
	SONNET,
} from "@yunomi/llm";
import { describe, expect, it } from "vitest";
import {
	CONTINUATION_WINDOW_MS,
	GATE_TIMEOUT_MS,
	INTERJECTION_COOLDOWN_MS,
} from "../src/do/turn.ts";
import { envelopeBody, inbound, PARTNER_ID, partnerStub } from "./helpers.ts";

const BOT = env.PARTNER_DISCORD_USER_ID;
const T0 = new Date("2026-10-11T03:00:00Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);

const turnResponse = (over: Partial<TurnResponse> = {}): TurnResponse => ({
	utterance: "こんにちは",
	reply_policy: "reply",
	decision_summary: "挨拶されたので返す",
	emotion_delta: { mood: 0, energy: 0 },
	relationship_delta: { familiarity: 0, trust: 0 },
	interest_signals: [],
	opinion_signals: [],
	memory_candidates: [],
	open_loops: [],
	resolved_open_loop_ids: [],
	performance: {
		emotion: "neutral",
		energy: 0.5,
		pace: "normal",
		warmth: 0.5,
		pause_before_ms: 0,
	},
	speak_aloud: false,
	tool_intents: [],
	needs_review: false,
	...over,
});

const llmOk = (output: TurnResponse | GateDecision, model = HAIKU) => ({
	ok: true as const,
	value: {
		output,
		model,
		usage: {
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
		latencyMs: 12,
		stopReason: "end_turn",
	} satisfies LLMResult<unknown>,
});

const gateOk = (join: boolean, reason = "判定の理由") =>
	llmOk({ join, reason });

const llmErr = (error: DomainError) => ({ ok: false as const, error });

/** DO ごとに FakeLLM と時計を差し込む。名前を分けて storage を独立させる。 */
const setup = async (
	name: string,
	opts: {
		script?: Parameters<FakeLLMProvider["enqueue"]>;
		env?: "production";
	} = {},
) => {
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider();
	if (opts.script) fake.enqueue(...opts.script);
	const clock = { now: T0 };
	await runInDurableObject(stub, (o) => {
		o.now = () => clock.now;
		o.createRouter = () => new ModelRouter({ provider: fake });
	});
	return { stub, fake, clock };
};

const mention = (over = {}) =>
	inbound({ mentionedUserIds: [BOT], content: "ゆかりん、おはよう", ...over });

describe("reply / ignore の判定", () => {
	it("メンションあり -> LLM -> reply（reply_to はトリガー発言）", async () => {
		const { stub, fake } = await setup("mention", {
			script: [llmOk(turnResponse({ utterance: "おはようございます" }))],
		});
		const msg = mention();
		const res = await stub.handleDiscordMessage(msg);

		expect(res).toMatchObject({
			action: "reply",
			content: "おはようございます",
			reply_to_message_id: msg.messageId,
		});
		expect(res.audit).toMatchObject({
			decision: "reply",
			reason: "llm",
			decisionSummary: "挨拶されたので返す",
			model: HAIKU,
			fallbackUsed: false,
			degraded: false,
			latencyMs: 12,
			errorType: null,
			usage: { inputTokens: 100, outputTokens: 20 },
			inbound: { messageId: msg.messageId, contentLength: msg.content.length },
		});
		expect(fake.requests).toHaveLength(1);
		const prompt = JSON.stringify(fake.requests[0]);
		expect(prompt).toContain("あなたへのメンションあり");
		expect(prompt).toContain("ゆかりん、おはよう");

		await runInDurableObject(stub, (_o, state) => {
			const sql = state.storage.sql;
			const partner = sql
				.exec<{ message_id: string; content: string; is_partner: number }>(
					"SELECT * FROM recent_messages WHERE is_partner = 1",
				)
				.toArray();
			expect(partner).toHaveLength(1);
			expect(partner[0]?.message_id).toMatch(/^partner:/);
			expect(partner[0]?.content).toBe("おはようございます");
			const st = sql
				.exec<{ last_partner_reply_at: string }>(
					"SELECT last_partner_reply_at FROM channel_state",
				)
				.one();
			expect(st.last_partner_reply_at).toBe(T0.toISOString());
		});
	});

	it("メンションなし・継続窓の外 -> Haiku が入らないと判定したら gate_rejected", async () => {
		const { stub, fake } = await setup("chitchat", {
			script: [gateOk(false, "人どうしの会話の途中")],
		});
		const res = await stub.handleDiscordMessage(
			inbound({ content: "ふむふむ" }),
		);
		expect(res.action).toBe("ignore");
		expect(res.audit).toMatchObject({
			reason: "gate_rejected",
			decisionSummary: "人どうしの会話の途中",
			model: HAIKU,
		});
		expect(fake.requests.map((r) => r.model)).toEqual([HAIKU]);
	});

	it("直近の返事から窓内なら LLM に回し、窓を過ぎたら回さない", async () => {
		const { stub, fake, clock } = await setup("window", {
			script: [
				llmOk(turnResponse()),
				llmOk(turnResponse({ utterance: "そうですね" })),
				gateOk(false),
			],
		});
		await stub.handleDiscordMessage(mention());

		clock.now = plus(CONTINUATION_WINDOW_MS - 1000);
		const within = await stub.handleDiscordMessage(
			inbound({ content: "だよね" }),
		);
		expect(within.action).toBe("reply");
		expect(fake.requests).toHaveLength(2);

		clock.now = plus(
			CONTINUATION_WINDOW_MS - 1000 + CONTINUATION_WINDOW_MS + 1000,
		);
		const outside = await stub.handleDiscordMessage(
			inbound({ content: "うん" }),
		);
		expect(outside.audit.reason).toBe("gate_rejected");
		expect(fake.requests.map((r) => r.model)).toEqual([SONNET, SONNET, HAIKU]);
	});

	it("Yukarin の発言への返信は窓外でも LLM に回す", async () => {
		const { stub, fake, clock } = await setup("reply-to", {
			script: [llmOk(turnResponse()), llmOk(turnResponse())],
		});
		await stub.handleDiscordMessage(mention());
		const partnerMessageId = await runInDurableObject(
			stub,
			(_o, state) =>
				state.storage.sql
					.exec<{ message_id: string }>(
						"SELECT message_id FROM recent_messages WHERE is_partner = 1",
					)
					.one().message_id,
		);
		clock.now = plus(60 * 60 * 1000);
		const res = await stub.handleDiscordMessage(
			inbound({ replyToMessageId: partnerMessageId }),
		);
		expect(res.action).toBe("reply");
		expect(fake.requests).toHaveLength(2);
	});

	it("bot の発言は LLM を呼ばず ignore（メンション付きでも）", async () => {
		const { stub, fake } = await setup("bot");
		const res = await stub.handleDiscordMessage(
			mention({ author: { id: "b1", displayName: "other-bot", isBot: true } }),
		);
		expect(res.action).toBe("ignore");
		expect(res.audit.reason).toBe("bot");
		expect(fake.requests).toHaveLength(0);
	});

	it("自分自身の発言は LLM を呼ばず捨てる", async () => {
		const { stub, fake } = await setup("self");
		const res = await stub.handleDiscordMessage(
			mention({ author: { id: BOT, displayName: "ゆかりん", isBot: true } }),
		);
		expect(res.audit.reason).toBe("self");
		expect(fake.requests).toHaveLength(0);
	});

	it("LLM が ignore を選んだら ignore（返事の時刻は更新しない）", async () => {
		const { stub } = await setup("llm-ignore", {
			script: [llmOk(turnResponse({ reply_policy: "ignore", utterance: "" }))],
		});
		const res = await stub.handleDiscordMessage(mention());
		expect(res.action).toBe("ignore");
		expect(res.audit).toMatchObject({ reason: "llm", decision: "ignore" });
		const rows = await runInDurableObject(stub, (_o, state) =>
			state.storage.sql.exec("SELECT * FROM channel_state").toArray(),
		);
		expect(rows).toHaveLength(0);
	});

	it("構造化出力の失敗 -> ignore + degraded", async () => {
		const { stub } = await setup("schema", {
			script: [llmErr(validationFailed({ issues: ["utterance: 長すぎる"] }))],
		});
		const res = await stub.handleDiscordMessage(mention());
		expect(res.action).toBe("ignore");
		expect(res.audit).toMatchObject({
			reason: "error",
			degraded: true,
			errorType: "ValidationFailed",
		});
	});

	it("primary 失敗時の fallback を記録する", async () => {
		const { stub, fake } = await setup("fallback", {
			env: "production",
			script: [
				llmErr(externalServiceUnavailable({ service: "anthropic" })),
				llmOk(turnResponse(), HAIKU),
			],
		});
		const res = await stub.handleDiscordMessage(mention());
		expect(res.action).toBe("reply");
		expect(res.audit).toMatchObject({ fallbackUsed: true, model: HAIKU });
		expect(fake.requests.map((r) => r.model)).toEqual([SONNET, HAIKU]);
	});

	it("チャンネルログは古い順に入り、新着メッセージ自身は含まない", async () => {
		const { stub, fake } = await setup("context", {
			script: [gateOk(false), llmOk(turnResponse())],
		});
		await stub.handleDiscordMessage(
			inbound({
				content: "先行の雑談",
				author: { id: "u2", displayName: "bob", isBot: false },
			}),
		);
		await stub.handleDiscordMessage(mention());
		const user = fake.requests[1]?.messages[0]?.content ?? "";
		const log = user.slice(0, user.indexOf("</channel_log>"));
		expect(log).toContain("bob: 先行の雑談");
		expect(log).not.toContain("ゆかりん、おはよう");
	});
});

const interjectionAt = (stub: ReturnType<typeof partnerStub>) =>
	runInDurableObject(
		stub,
		(_o, state) =>
			state.storage.sql
				.exec<{ last_interjection_at: string | null }>(
					"SELECT last_interjection_at FROM channel_state",
				)
				.toArray()[0]?.last_interjection_at ?? null,
	);

describe("宛先のない発言への割り込み", () => {
	const free = (over = {}) =>
		inbound({ content: "このゲーム面白いよ", ...over });

	it("本文にプロファイルの呼び名があれば、判定なしで Sonnet に回す（英字は大文字小文字を区別しない）", async () => {
		const { stub, fake } = await setup("alias", {
			script: [llmOk(turnResponse()), llmOk(turnResponse())],
		});
		const a = await stub.handleDiscordMessage(
			free({ content: "結月さんは？" }),
		);
		const b = await stub.handleDiscordMessage(
			free({ content: "Yukari どう？" }),
		);
		expect([a.action, b.action]).toEqual(["reply", "reply"]);
		expect(fake.requests.map((r) => r.model)).toEqual([SONNET, SONNET]);
		expect(await interjectionAt(stub)).toBeNull();
	});

	it("自分以外へのメンションは Haiku を呼ばず addressed_to_other", async () => {
		const { stub, fake } = await setup("to-other-mention");
		const res = await stub.handleDiscordMessage(
			free({ mentionedUserIds: ["u9"] }),
		);
		expect(res.audit.reason).toBe("addressed_to_other");
		expect(fake.requests).toHaveLength(0);
	});

	it("自分以外の発言へのリプライは、既知でも未知でも addressed_to_other", async () => {
		const { stub, fake } = await setup("to-other-reply");
		const bob = free({
			author: { id: "u2", displayName: "bob", isBot: false },
		});
		await stub.handleDiscordMessage(free({ mentionedUserIds: ["u9"] }));
		await stub.handleDiscordMessage(bob);
		const known = await stub.handleDiscordMessage(
			free({ replyToMessageId: bob.messageId }),
		);
		const unknown = await stub.handleDiscordMessage(
			free({ replyToMessageId: "not-in-store" }),
		);
		expect(known.audit.reason).toBe("addressed_to_other");
		expect(unknown.audit.reason).toBe("addressed_to_other");
		expect(fake.requests.length).toBe(1);
	});

	it("Haiku が入ると判定したら Sonnet に回し、reply したときだけ割り込み時刻を記録する", async () => {
		const { stub, fake } = await setup("join", {
			script: [
				gateOk(true, "ゲームの話題"),
				llmOk(turnResponse({ utterance: "面白そうですね" })),
			],
		});
		const res = await stub.handleDiscordMessage(free());
		expect(res).toMatchObject({ action: "reply", content: "面白そうですね" });
		expect(fake.requests.map((r) => r.model)).toEqual([HAIKU, SONNET]);
		expect(fake.requests[0]?.timeoutMs).toBe(GATE_TIMEOUT_MS);
		expect(fake.requests[1]?.timeoutMs).toBeUndefined();
		expect(await interjectionAt(stub)).toBe(T0.toISOString());
	});

	it("ゲートには人数・状態・発言者との関係を渡し、判定のために entity は作らない", async () => {
		const { stub, fake } = await setup("gate-context", {
			script: [gateOk(false), gateOk(false), gateOk(false)],
		});
		const alice = { id: "u-gate-a", displayName: "alice", isBot: false };
		const bob = { id: "u-gate-b", displayName: "bob", isBot: false };
		await stub.handleDiscordMessage(free({ author: alice }));
		const first = fake.requests[0]?.messages[0]?.content ?? "";
		expect(first).toContain("alice だけで、あなたと 2 人きり");
		expect(first).toContain("alice とはまだ関係がない（初めての相手）。");
		expect(first).toContain("presence: available");
		const row = await env.DB.prepare(
			"SELECT count(*) AS n FROM external_identities WHERE external_id = 'u-gate-a'",
		).first<{ n: number }>();
		expect(row?.n).toBe(0);

		await stub.handleDiscordMessage(free({ author: bob }));
		expect(fake.requests[1]?.messages[0]?.content).toContain(
			"この場で話している人は 2 人。",
		);
	});

	it("bot の発言は人数に数えず、ログでは bot と示す", async () => {
		const { stub, fake } = await setup("gate-bot", {
			script: [gateOk(false)],
		});
		const notifier = { id: "b-notify", displayName: "茶畑", isBot: true };
		const alice = { id: "u-gate-bot", displayName: "alice", isBot: false };
		await stub.handleDiscordMessage(
			free({ author: notifier, content: "GPU 機が復帰しました" }),
		);
		await stub.handleDiscordMessage(free({ author: alice }));
		const gate = fake.requests[0]?.messages[0]?.content ?? "";
		expect(gate).toContain("alice だけで、あなたと 2 人きり");
		expect(gate).toContain("茶畑（bot）");
	});

	it("関係のある発言者なら、ゲートに関係の段階と数値を渡す", async () => {
		const { stub, fake } = await setup("gate-rel", {
			script: [llmOk(turnResponse()), gateOk(false)],
		});
		const alice = { id: "u-gate-r", displayName: "alice", isBot: false };
		await stub.handleDiscordMessage(mention({ author: alice }));
		await stub.handleDiscordMessage(
			free({ author: alice, channelId: "c-rel" }),
		);
		const gate = fake.requests[1]?.messages[0]?.content ?? "";
		expect(gate).toMatch(
			/alice との関係: .+（familiarity \d\.\d{2}、trust \d\.\d{2}）/,
		);
	});

	it("入ると判定されても Sonnet が ignore を選べば、割り込み時刻は記録しない", async () => {
		const { stub } = await setup("join-ignore", {
			script: [
				gateOk(true),
				llmOk(turnResponse({ reply_policy: "ignore", utterance: "" })),
			],
		});
		const res = await stub.handleDiscordMessage(free());
		expect(res.audit).toMatchObject({ decision: "ignore", reason: "llm" });
		expect(await interjectionAt(stub)).toBeNull();
	});

	it("メンションへの通常の返事では割り込み時刻を記録しない", async () => {
		const { stub } = await setup("mention-no-stamp", {
			script: [llmOk(turnResponse())],
		});
		await stub.handleDiscordMessage(mention());
		expect(await interjectionAt(stub)).toBeNull();
	});

	it("割り込みから 30 分以内は Haiku を呼ばず interjection_cooldown、過ぎたら判定する", async () => {
		const { stub, fake, clock } = await setup("cooldown", {
			script: [gateOk(true), llmOk(turnResponse()), gateOk(false, "相づち")],
		});
		await stub.handleDiscordMessage(free());

		clock.now = plus(INTERJECTION_COOLDOWN_MS - 1000);
		const within = await stub.handleDiscordMessage(free());
		expect(within.audit.reason).toBe("interjection_cooldown");
		expect(fake.requests).toHaveLength(2);

		clock.now = plus(INTERJECTION_COOLDOWN_MS + 1000);
		const after = await stub.handleDiscordMessage(free());
		expect(after.audit.reason).toBe("gate_rejected");
		expect(fake.requests).toHaveLength(3);
	});

	it("割り込みの会話から記憶の候補が作られ、判定の失敗は黙って llm_health に数えない", async () => {
		const { stub } = await setup("memory-and-failure", {
			script: [
				llmErr(externalServiceUnavailable({ service: "anthropic" })),
				gateOk(true),
				llmOk(
					turnResponse({
						memory_candidates: [
							{
								subject: "user",
								predicate: "好きなジャンル",
								object: { type: "string", value: "RPG" },
								confidence: 0.9,
								importance: 0.7,
								source: "user_statement",
							},
						],
					}),
				),
			],
		});
		const failed = await stub.handleDiscordMessage(free());
		expect(failed.action).toBe("ignore");
		expect(failed.audit).toMatchObject({
			reason: "gate_failed",
			degraded: false,
			errorType: "ExternalServiceUnavailable",
		});
		const streak = await runInDurableObject(stub, (_o, state) =>
			state.storage.sql.exec("SELECT * FROM llm_health").toArray(),
		);
		expect(streak).toEqual([]);

		const joined = await stub.handleDiscordMessage(
			free({ content: "RPG が好きなんだよね" }),
		);
		expect(joined.action).toBe("reply");
		expect(joined.audit.memory?.outcomes).toHaveLength(1);
	});

	it("判定の出力が検証に失敗しても黙る", async () => {
		const { stub } = await setup("gate-invalid", {
			script: [llmErr(validationFailed({ issues: ["join: 型が違う"] }))],
		});
		const res = await stub.handleDiscordMessage(free());
		expect(res.audit).toMatchObject({
			reason: "gate_failed",
			errorType: "ValidationFailed",
		});
	});
});

describe("HTTP 経由", () => {
	it("gateway のリクエストに reply を返す", async () => {
		await setup(PARTNER_ID, {
			script: [llmOk(turnResponse({ utterance: "はい" }))],
		});
		const msg = mention();
		const res = await exports.default.fetch(
			new Request("http://localhost/v1/interfaces/discord/events", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-yunomi-dev-caller": "gateway",
				},
				body: JSON.stringify(envelopeBody(msg)),
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			action: "reply",
			content: "はい",
			reply_to_message_id: msg.messageId,
			partner_message_id: expect.stringMatching(/^partner:/),
		});
	});
});
