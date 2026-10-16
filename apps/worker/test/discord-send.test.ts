import { runInDurableObject } from "cloudflare:test";
import { type CommunicationPort, err, ok, rateLimited } from "@yunomi/core";
import { type FakeLLMProvider, ModelRouter } from "@yunomi/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TYPING_DELAY_MS } from "../src/do/partner-do.ts";
import { DoStore } from "../src/do/store.ts";
import {
	gate,
	installFakeLlm,
	llmOk,
	mention,
	newScenario,
	send,
	turn,
} from "./e2e/harness.ts";
import { inbound, PARTNER_ID, partnerStub } from "./helpers.ts";

type TextInput = { channelId: string; text: string; replyToMessageId?: string };

const fakePort = (over: Partial<CommunicationPort> = {}) => ({
	sendText: vi.fn(async (_i: TextInput) => ok({ messageId: "d-500" })),
	sendTyping: vi.fn(async (_i: { channelId: string }) => ok(undefined)),
	sendAttachment: vi.fn(),
	...over,
});

const install = (port: CommunicationPort | null) =>
	runInDurableObject(partnerStub(PARTNER_ID), (o) => {
		o.createCommunication = () => port;
	});

afterEach(() => install(null));

// LLM の応答を TYPING_DELAY_MS より遅らせる。
const slowLlm = (fake: FakeLLMProvider) =>
	runInDurableObject(partnerStub(PARTNER_ID), (o) => {
		o.createRouter = () =>
			new ModelRouter({
				provider: {
					generate: async (req) => {
						await new Promise((r) => setTimeout(r, TYPING_DELAY_MS + 200));
						return fake.generate(req);
					},
				},
			});
	});

describe("Worker からの送信", () => {
	it("返事を REST で送り、Gateway には ack だけを返す", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(turn({ utterance: "おはよう" }))]);
		const port = fakePort();
		await install(port);
		const msg = mention(s);

		expect(await send(msg)).toEqual({ action: "ack" });

		expect(port.sendText).toHaveBeenCalledWith({
			channelId: s.channelId,
			text: "おはよう",
		});
		expect(vi.mocked(port.sendText).mock.calls[0]?.[0]).not.toHaveProperty(
			"replyToMessageId",
		);
	});

	it("考えているあいだに他の発言が入れば、返信形式で送る", async () => {
		const s = newScenario();
		const fake = await installFakeLlm([llmOk(turn({ utterance: "おはよう" }))]);
		const port = fakePort();
		await install(port);
		const msg = mention(s);
		await runInDurableObject(partnerStub(PARTNER_ID), (o, st) => {
			o.createRouter = () =>
				new ModelRouter({
					provider: {
						generate: async (req) => {
							new DoStore(st.storage.sql).appendRecent({
								channelId: s.channelId,
								messageId: `late-${msg.messageId}`,
								authorId: "u-other",
								authorName: "bob",
								isBot: true,
								isPartner: false,
								content: "割り込み",
								occurredAt: "2026-10-11T03:00:00.000Z",
							});
							return fake.generate(req);
						},
					},
				});
		});

		await send(msg);

		expect(port.sendText).toHaveBeenCalledWith({
			channelId: s.channelId,
			text: "おはよう",
			replyToMessageId: msg.messageId,
		});
	});

	it("送った message id を partner 発言に結び付ける", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(turn())]);
		await install(fakePort());
		await send(mention(s));

		const rows = await runInDurableObject(partnerStub(PARTNER_ID), (_o, st) =>
			st.storage.sql
				.exec<{ discord_message_id: string | null }>(
					"SELECT discord_message_id FROM recent_messages WHERE channel_id = ? AND is_partner = 1",
					s.channelId,
				)
				.toArray(),
		);
		expect(rows).toEqual([{ discord_message_id: "d-500" }]);
	});

	it("送信に失敗しても reply は返さない", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(turn())]);
		await install(
			fakePort({
				sendText: vi.fn(async () => err(rateLimited({ retryAfterMs: 9000 }))),
			}),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect(await send(mention(s))).toEqual({ action: "ack" });
	});

	it("ignore は何も送らない", async () => {
		const s = newScenario();
		await installFakeLlm([]);
		const port = fakePort();
		await install(port);

		const res = await send(
			inbound({ channelId: s.channelId, author: s.author, content: "寒いね" }),
		);

		expect(res).toEqual({ action: "ignore" });
		expect(port.sendText).not.toHaveBeenCalled();
		expect(port.sendTyping).not.toHaveBeenCalled();
	});

	it("応答が遅いときだけ入力中を出す", async () => {
		const s = newScenario();
		const fake = await installFakeLlm([llmOk(turn())]);
		const port = fakePort();
		await install(port);
		await slowLlm(fake);

		await send(mention(s));

		expect(port.sendTyping).toHaveBeenCalledWith({ channelId: s.channelId });
	});

	it("gate で黙る発言には、判定が遅くても入力中を出さない", async () => {
		const s = newScenario();
		const fake = await installFakeLlm([gate(false)]);
		const port = fakePort();
		await install(port);
		await slowLlm(fake);

		const res = await send(
			inbound({ channelId: s.channelId, author: s.author, content: "寒いね" }),
		);

		expect(res).toEqual({ action: "ignore" });
		expect(port.sendTyping).not.toHaveBeenCalled();
	});

	it("port が無ければ従来どおり reply を返す", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(turn({ utterance: "やあ" }))]);
		await install(null);

		expect(await send(mention(s))).toMatchObject({
			action: "reply",
			content: "やあ",
		});
	});
});
