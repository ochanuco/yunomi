import { runInDurableObject } from "cloudflare:test";
import { type CommunicationPort, err, ok, rateLimited } from "@yunomi/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TYPING_DELAY_MS } from "../src/do/partner-do.ts";
import {
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
		await installFakeLlm([llmOk(turn())]);
		const port = fakePort();
		await install(port);
		await runInDurableObject(partnerStub(PARTNER_ID), (o) => {
			const base = o.pipeline;
			o.pipeline = async (m) => {
				await new Promise((r) => setTimeout(r, TYPING_DELAY_MS + 200));
				return base(m);
			};
		});

		await send(mention(s));

		expect(port.sendTyping).toHaveBeenCalledWith({ channelId: s.channelId });
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
