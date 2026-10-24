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
import { ACK, inbound, PARTNER_ID, partnerStub } from "./helpers.ts";

type TextInput = {
	channelId: string;
	text: string;
	replyToMessageId?: string;
	nonce?: string;
};

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
		await installFakeLlm([llmOk(turn({ messages: ["おはよう"] }))]);
		const port = fakePort();
		await install(port);
		const msg = mention(s);

		expect(await send(msg)).toEqual(ACK);

		expect(port.sendText).toHaveBeenCalledWith({
			channelId: s.channelId,
			text: "おはよう",
			nonce: `${msg.messageId}:0`,
		});
		expect(vi.mocked(port.sendText).mock.calls[0]?.[0]).not.toHaveProperty(
			"replyToMessageId",
		);
	});

	it("送り終えた返事の感情を、表情画像の指示として Gateway に返す", async () => {
		const s = newScenario();
		await installFakeLlm([
			llmOk(
				turn({
					messages: ["やった", "ほんとに"],
					performance: { ...turn().performance, emotion: "joy" },
				}),
			),
		]);
		await install(fakePort());

		expect(await send(mention(s))).toEqual({
			action: "ack",
			avatar: { emotion: "joy" },
		});
	});

	it("考えているあいだに他の発言が入れば、返信形式で送る", async () => {
		const s = newScenario();
		const fake = await installFakeLlm([
			llmOk(turn({ messages: ["おはよう"] })),
		]);
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
			nonce: `${msg.messageId}:0`,
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

	describe("複数件の返事", () => {
		const three = () =>
			turn({
				messages: ["えっ", "それは初耳ですね", "詳しく聞かせてください"],
			});

		// 送信・入力中・待ちの順番を 1 本の列で見る。
		const recording = async () => {
			const events: string[] = [];
			let n = 0;
			const port = fakePort({
				sendText: vi.fn(async (i: TextInput) => {
					events.push(`send:${i.text}`);
					n++;
					return ok({ messageId: `d-${n}` });
				}),
				sendTyping: vi.fn(async () => {
					events.push("typing");
					return ok(undefined);
				}),
			});
			await install(port);
			await runInDurableObject(partnerStub(PARTNER_ID), (o) => {
				o.sleep = async (ms) => {
					events.push(`sleep:${ms}`);
				};
			});
			return { events, port };
		};

		const partnerRows = (channelId: string) =>
			runInDurableObject(partnerStub(PARTNER_ID), (_o, st) =>
				st.storage.sql
					.exec<{
						message_id: string;
						content: string;
						discord_message_id: string | null;
					}>(
						"SELECT message_id, content, discord_message_id FROM recent_messages WHERE channel_id = ? AND is_partner = 1 ORDER BY rowid",
						channelId,
					)
					.toArray(),
			);

		afterEach(() =>
			runInDurableObject(partnerStub(PARTNER_ID), (o) => {
				o.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			}),
		);

		it("順に送り、2 件目以降の前は入力中を出して文字数に応じて待つ", async () => {
			const s = newScenario();
			await installFakeLlm([llmOk(three())]);
			const { events, port } = await recording();

			expect(await send(mention(s))).toEqual(ACK);

			expect(events).toEqual([
				"send:えっ",
				"typing",
				`sleep:${600 + 40 * 8}`,
				"send:それは初耳ですね",
				"typing",
				`sleep:${600 + 40 * 11}`,
				"send:詳しく聞かせてください",
			]);
			expect(port.sendText).toHaveBeenCalledTimes(3);
			expect(await partnerRows(s.channelId)).toEqual([
				{
					message_id: expect.stringMatching(/^partner:.+:0$/),
					content: "えっ",
					discord_message_id: "d-1",
				},
				{
					message_id: expect.stringMatching(/^partner:.+:1$/),
					content: "それは初耳ですね",
					discord_message_id: "d-2",
				},
				{
					message_id: expect.stringMatching(/^partner:.+:2$/),
					content: "詳しく聞かせてください",
					discord_message_id: "d-3",
				},
			]);
		});

		it("返信形式にするのは 1 件目だけで、nonce は件ごとに違い、入力から決まる", async () => {
			const s = newScenario();
			const fake = await installFakeLlm([llmOk(three())]);
			const { port } = await recording();
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
									isBot: false,
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

			const calls = vi.mocked(port.sendText).mock.calls.map((c) => c[0]);
			expect(calls.map((c) => c.replyToMessageId)).toEqual([
				msg.messageId,
				undefined,
				undefined,
			]);
			expect(calls.map((c) => c.nonce)).toEqual([
				`${msg.messageId}:0`,
				`${msg.messageId}:1`,
				`${msg.messageId}:2`,
			]);
		});

		it("送っている途中に Gateway が同じ発言を再送しても、二重に送らない", async () => {
			const s = newScenario();
			await installFakeLlm([llmOk(three())]);
			const { port } = await recording();
			const msg = mention(s);

			const [a, b] = await Promise.all([send(msg), send(msg)]);

			expect(a).toEqual(ACK);
			expect(b).toEqual(ACK);
			expect(port.sendText).toHaveBeenCalledTimes(3);
			expect(await send(msg)).toEqual(ACK);
			expect(port.sendText).toHaveBeenCalledTimes(3);
		});

		it("途中の 1 件が失敗したら残りは送らず、送れた分だけを記録する", async () => {
			const s = newScenario();
			await installFakeLlm([llmOk(three())]);
			const { port } = await recording();
			vi.mocked(port.sendText)
				.mockImplementationOnce(async () => ok({ messageId: "d-1" }))
				.mockImplementationOnce(async () =>
					err(rateLimited({ retryAfterMs: 9000 })),
				);
			const error = vi.spyOn(console, "error").mockImplementation(() => {});

			expect(await send(mention(s))).toEqual({ action: "ack" });

			expect(port.sendText).toHaveBeenCalledTimes(2);
			expect(error).toHaveBeenCalledWith(
				"discord send failed",
				"RateLimited",
				expect.any(String),
				{ index: 1, unsent: 2 },
			);
			expect(await partnerRows(s.channelId)).toEqual([
				{
					message_id: expect.stringMatching(/:0$/),
					content: "えっ",
					discord_message_id: "d-1",
				},
			]);
		});
	});

	it("port が無ければ従来どおり reply を返す", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(turn({ messages: ["やあ"] }))]);
		await install(null);

		expect(await send(mention(s))).toMatchObject({
			action: "reply",
			messages: [{ content: "やあ" }],
		});
	});
});
