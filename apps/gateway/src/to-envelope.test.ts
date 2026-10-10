import { toInboundMessage } from "@yunomi/protocol";
import { describe, expect, it } from "vitest";
import { type MessageLike, toEnvelope } from "./to-envelope.ts";

const opts = {
	partnerId: "yukarin",
	botUserId: "999",
	now: new Date("2026-01-01T00:00:05.000Z"),
};

const msg = (over: Partial<MessageLike> = {}): MessageLike => ({
	id: "3",
	guildId: "1",
	channelId: "2",
	content: "こんにちは",
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	author: { id: "4", bot: false, displayName: "alice" },
	mentionedUserIds: [],
	mentionsBotRole: false,
	replyToMessageId: null,
	attachments: [],
	...over,
});

describe("toEnvelope", () => {
	it("基本フィールドを protocol の名前で写し、契約の検証を通る", () => {
		const r = toEnvelope(msg(), opts);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value).toMatchObject({
			type: "discord.message.created",
			source: "discord",
			partner_id: "yukarin",
			occurred_at: "2026-01-01T00:00:00.000Z",
			received_at: "2026-01-01T00:00:05.000Z",
			schema_version: 1,
			payload: {
				guild_id: "1",
				channel_id: "2",
				message_id: "3",
				content: "こんにちは",
				author: { id: "4", display_name: "alice", is_bot: false },
			},
		});
		expect(r.value.event_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(toInboundMessage(r.value).ok).toBe(true);
	});

	it("bot へのメンションを mentions に含める", () => {
		const r = toEnvelope(msg({ mentionedUserIds: ["999", "5", "5"] }), opts);
		expect(r.ok && r.value.payload.mentions).toEqual(["999", "5"]);
	});

	it("bot の管理ロールへのメンションは bot 本人へのメンションとして含める", () => {
		const r = toEnvelope(
			msg({ mentionedUserIds: ["5", "999"], mentionsBotRole: true }),
			opts,
		);
		expect(r.ok && r.value.payload.mentions).toEqual(["5", "999"]);
		const roleOnly = toEnvelope(msg({ mentionsBotRole: true }), opts);
		expect(roleOnly.ok && roleOnly.value.payload.mentions).toEqual(["999"]);
	});

	it("返信先 message id を写す", () => {
		const r = toEnvelope(msg({ replyToMessageId: "77" }), opts);
		expect(r.ok && r.value.payload.reply_to_message_id).toBe("77");
	});

	it("bot 発言は is_bot=true のまま送る", () => {
		const r = toEnvelope(
			msg({ author: { id: "8", bot: true, displayName: "otherbot" } }),
			opts,
		);
		expect(r.ok && r.value.payload.author.is_bot).toBe(true);
	});

	it("添付はメタデータのみ", () => {
		const r = toEnvelope(
			msg({
				attachments: [{ name: "a.png", contentType: "image/png", size: 10 }],
			}),
			opts,
		);
		expect(r.ok && r.value.payload.attachments).toEqual([
			{ name: "a.png", content_type: "image/png", size: 10 },
		]);
	});

	it("自分の発言と guild 外は変換しない", () => {
		expect(
			toEnvelope(
				msg({ author: { id: "999", bot: true, displayName: "me" } }),
				opts,
			).ok,
		).toBe(false);
		expect(toEnvelope(msg({ guildId: null }), opts).ok).toBe(false);
	});
});
