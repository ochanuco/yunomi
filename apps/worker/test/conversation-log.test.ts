import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ok } from "@yunomi/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTEXT_BEFORE_COUNT } from "../src/conversation-log.ts";
import { DoStore } from "../src/do/store.ts";
import {
	installFakeLlm,
	llmOk,
	mention,
	newScenario,
	send,
	turn,
} from "./e2e/harness.ts";
import { inbound, PARTNER_ID, partnerStub } from "./helpers.ts";

type LogRow = {
	channel_id: string;
	message_id: string;
	discord_message_id: string | null;
	turn_event_id: string;
	author_id: string;
	is_bot: number;
	is_partner: number;
	content: string;
};

const logFor = async (channelId: string) =>
	(
		await env.DB.prepare(
			"SELECT * FROM conversation_messages WHERE partner_id = ? AND channel_id = ? ORDER BY rowid",
		)
			.bind(PARTNER_ID, channelId)
			.all<LogRow>()
	).results;

// 返事に至らない雑談は LLM の判定を通るので、文脈には DO の履歴へ直接積む。
const chat = (s: ReturnType<typeof newScenario>, content: string, at: number) =>
	runInDurableObject(partnerStub(PARTNER_ID), (_o, st) => {
		new DoStore(st.storage.sql).appendRecent({
			channelId: s.channelId,
			messageId: `ctx-${s.channelId}-${at}`,
			authorId: s.author.id,
			authorName: s.author.displayName,
			isBot: false,
			isPartner: false,
			content,
			occurredAt: new Date(Date.UTC(2026, 9, 11, 3, 0, at)).toISOString(),
		});
	});

const reply = (text: string) => llmOk(turn({ messages: [text] }));

afterEach(() =>
	runInDurableObject(partnerStub(PARTNER_ID), (o) => {
		o.createCommunication = () => null;
	}),
);

describe("conversation_messages", () => {
	it("返事をしたターンで、直前の文脈・受信・返事が入る", async () => {
		const s = newScenario();
		await installFakeLlm([reply("おはよう")]);
		await chat(s, "雑談その1", 0);
		const msg = mention(s, { occurredAt: new Date("2026-10-11T03:00:10Z") });
		const res = await send(msg);

		const rows = await logFor(s.channelId);
		expect(rows.map((r) => r.content)).toEqual([
			"雑談その1",
			"ゆかりん、おはよう",
			"おはよう",
		]);
		expect(rows.map((r) => r.is_partner)).toEqual([0, 0, 1]);
		expect(rows[1]).toMatchObject({
			message_id: msg.messageId,
			discord_message_id: null,
			turn_event_id: msg.eventId,
		});
		expect(rows[2]?.message_id).toBe(res.messages[0]?.partner_message_id);
	});

	it("ignore のターンでは何も入らない", async () => {
		const s = newScenario();
		await installFakeLlm([]);
		await send(mention(s, { mentionedUserIds: ["someone-else"] }));
		expect(await logFor(s.channelId)).toHaveLength(0);
	});

	it("同じ文脈が次の返事ターンでも拾われて、重複しない", async () => {
		const s = newScenario();
		await installFakeLlm([reply("一つ目"), reply("二つ目")]);
		await chat(s, "雑談", 0);
		await send(mention(s, { occurredAt: new Date("2026-10-11T03:00:10Z") }));
		await send(
			mention(s, {
				content: "ゆかりん、もう一回",
				occurredAt: new Date("2026-10-11T03:00:20Z"),
			}),
		);

		const rows = await logFor(s.channelId);
		expect(rows.map((r) => r.content)).toEqual([
			"雑談",
			"ゆかりん、おはよう",
			"一つ目",
			"ゆかりん、もう一回",
			"二つ目",
		]);
		expect(new Set(rows.map((r) => r.message_id)).size).toBe(rows.length);
	});

	it("bot の発言も文脈として記録される", async () => {
		const s = newScenario();
		await installFakeLlm([reply("やあ")]);
		await send(
			inbound({
				channelId: s.channelId,
				author: { id: "other-bot", displayName: "bot", isBot: true },
				content: "bot の発言",
				occurredAt: new Date("2026-10-11T03:00:00Z"),
			}),
		);
		await send(mention(s, { occurredAt: new Date("2026-10-11T03:00:10Z") }));

		const rows = await logFor(s.channelId);
		expect(rows[0]).toMatchObject({
			content: "bot の発言",
			author_id: "other-bot",
			is_bot: 1,
			is_partner: 0,
		});
	});

	it(`直前の文脈は ${CONTEXT_BEFORE_COUNT} 件までにする`, async () => {
		const s = newScenario();
		await installFakeLlm([reply("やあ")]);
		for (let i = 0; i < CONTEXT_BEFORE_COUNT + 3; i++) {
			await chat(s, `雑談${i}`, i);
		}
		await send(mention(s, { occurredAt: new Date("2026-10-11T03:05:00Z") }));

		const rows = await logFor(s.channelId);
		expect(rows).toHaveLength(CONTEXT_BEFORE_COUNT + 2);
		expect(rows[0]?.content).toBe("雑談3");
	});

	it("Worker 送信モードでは、送れた返事に Discord の message id が入る", async () => {
		const s = newScenario();
		await installFakeLlm([reply("おはよう")]);
		await runInDurableObject(partnerStub(PARTNER_ID), (o) => {
			o.createCommunication = () => ({
				sendText: vi.fn(async () => ok({ messageId: "d-900" })),
				sendTyping: vi.fn(async () => ok(undefined)),
				sendAttachment: vi.fn(),
			});
		});
		await send(mention(s));

		const rows = await logFor(s.channelId);
		expect(rows.map((r) => r.content)).toEqual([
			"ゆかりん、おはよう",
			"おはよう",
		]);
		expect(rows[1]).toMatchObject({
			is_partner: 1,
			discord_message_id: "d-900",
		});
		expect(rows[1]?.message_id).toMatch(/^partner:/);
		expect(rows[0]?.discord_message_id).toBeNull();
	});
});
