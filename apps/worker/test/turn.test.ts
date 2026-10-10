import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { TurnResponse } from "@yunomi/conversation";
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
import { CONTINUATION_WINDOW_MS } from "../src/do/turn.ts";
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
	interest_delta: [],
	memory_candidates: [],
	open_loop_updates: [],
	tool_intents: [],
	needs_review: false,
	...over,
});

const llmOk = (output: TurnResponse, model = HAIKU) => ({
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

	it("メンションなし・継続窓の外 -> LLM を呼ばず ignore", async () => {
		const { stub, fake } = await setup("chitchat");
		const res = await stub.handleDiscordMessage(
			inbound({ content: "ふむふむ" }),
		);
		expect(res.action).toBe("ignore");
		expect(res.audit.reason).toBe("not_addressed");
		expect(fake.requests).toHaveLength(0);
	});

	it("直近の返事から窓内なら LLM に回し、窓を過ぎたら回さない", async () => {
		const { stub, fake, clock } = await setup("window", {
			script: [
				llmOk(turnResponse()),
				llmOk(turnResponse({ utterance: "そうですね" })),
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
		expect(outside.audit.reason).toBe("not_addressed");
		expect(fake.requests).toHaveLength(2);
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
			script: [llmOk(turnResponse())],
		});
		await stub.handleDiscordMessage(
			inbound({
				content: "先行の雑談",
				author: { id: "u2", displayName: "bob", isBot: false },
			}),
		);
		await stub.handleDiscordMessage(mention());
		const user = fake.requests[0]?.messages[0]?.content ?? "";
		const log = user.slice(0, user.indexOf("</channel_log>"));
		expect(log).toContain("bob: 先行の雑談");
		expect(log).not.toContain("ゆかりん、おはよう");
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
