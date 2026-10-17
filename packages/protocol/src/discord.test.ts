import { newId } from "@yunomi/core";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
	dedupeKey,
	discordSentSchema,
	discordVoiceConnectionSchema,
	gatewayResponseSchema,
	toInboundMessage,
	toVoiceStateUpdate,
	voiceResponseSchema,
} from "./discord.ts";

const valid = () => ({
	event_id: newId(),
	type: "discord.message.created",
	source: "discord",
	partner_id: "yukarin",
	occurred_at: "2026-01-01T00:00:00.000Z",
	received_at: "2026-01-01T00:00:01.000Z",
	schema_version: 1,
	payload: {
		guild_id: "1",
		channel_id: "2",
		message_id: "3",
		author: { id: "4", display_name: "alice", is_bot: false },
		content: "こんにちは",
		mentions: ["5"],
		reply_to_message_id: "9",
		attachments: [{ name: "a.png", content_type: "image/png", size: 10 }],
	},
});

describe("toInboundMessage", () => {
	it("正常な payload を内部型へ変換する", () => {
		const r = toInboundMessage(valid());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value).toMatchObject({
			guildId: "1",
			channelId: "2",
			messageId: "3",
			content: "こんにちは",
			mentionedUserIds: ["5"],
			replyToMessageId: "9",
			author: { id: "4", displayName: "alice", isBot: false },
			attachments: [{ name: "a.png", contentType: "image/png", size: 10 }],
		});
		expect(r.value.occurredAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
	});

	it("返信先と添付の type が無ければ null にする", () => {
		const e = valid();
		const { reply_to_message_id: _, ...rest } = e.payload;
		const r = toInboundMessage({
			...e,
			payload: {
				...rest,
				attachments: [{ name: "x", size: 1 }],
			},
		});
		expect(r.ok && r.value.replyToMessageId).toBeNull();
		expect(r.ok && r.value.attachments[0]?.contentType).toBeNull();
	});

	it("bot 発言も isBot=true で変換する", () => {
		const e = valid();
		e.payload.author.is_bot = true;
		const r = toInboundMessage(e);
		expect(r.ok && r.value.author.isBot).toBe(true);
	});

	it("必須フィールド欠落は ValidationFailed", () => {
		const e = valid();
		const { message_id: _, ...payload } = e.payload;
		const r = toInboundMessage({ ...e, payload });
		expect(!r.ok && r.error.type).toBe("ValidationFailed");
		expect(
			!r.ok && r.error.type === "ValidationFailed" && r.error.issues.join(),
		).toContain("message_id");
	});

	it("不正な型は ValidationFailed", () => {
		const e = valid();
		const r = toInboundMessage({
			...e,
			payload: { ...e.payload, mentions: "5" },
		});
		expect(!r.ok && r.error.type).toBe("ValidationFailed");
	});

	it("type / source が違うと ValidationFailed", () => {
		expect(toInboundMessage({ ...valid(), type: "other" }).ok).toBe(false);
		expect(toInboundMessage({ ...valid(), source: "slack" }).ok).toBe(false);
	});
});

describe("dedupeKey", () => {
	it("discord:<message_id> を返す", () => {
		const r = toInboundMessage(valid());
		expect(r.ok && dedupeKey(r.value)).toBe("discord:3");
	});
});

describe("gatewayResponseSchema", () => {
	const ok = (x: unknown) => v.safeParse(gatewayResponseSchema, x).success;
	it("reply / ignore / ack を受理する", () => {
		expect(ok({ action: "ack" })).toBe(true);
		expect(ok({ action: "reply", content: "やあ" })).toBe(true);
		expect(
			ok({
				action: "reply",
				content: "やあ\n元気ですか",
				messages: [{ content: "やあ" }, { content: "元気ですか" }],
				reply_to_message_id: "3",
			}),
		).toBe(true);
		expect(ok({ action: "ignore" })).toBe(true);
	});
	it("空・2000 文字超・0 件・11 件・未知の action を拒否する", () => {
		const reply = (...contents: string[]) => ({
			action: "reply",
			content: "a",
			messages: contents.map((content) => ({ content })),
		});
		expect(ok({ action: "reply", content: "" })).toBe(false);
		expect(ok({ action: "reply", content: "a".repeat(2001) })).toBe(false);
		expect(ok(reply(""))).toBe(false);
		expect(ok(reply("a".repeat(2001)))).toBe(false);
		expect(ok(reply("a".repeat(2000)))).toBe(true);
		expect(ok(reply())).toBe(false);
		expect(ok(reply(...Array<string>(10).fill("a")))).toBe(true);
		expect(ok(reply(...Array<string>(11).fill("a")))).toBe(false);
		expect(ok({ action: "dm" })).toBe(false);
	});
});

describe("discordSentSchema", () => {
	const sent = {
		partner_message_id: "partner:abc",
		channel_id: "2",
		discord_message_id: "100",
	};

	it("有効な body を受け付ける", () => {
		expect(v.safeParse(discordSentSchema, sent).success).toBe(true);
	});

	it.each(["partner_message_id", "channel_id", "discord_message_id"] as const)(
		"%s が空なら拒否する",
		(key) => {
			expect(
				v.safeParse(discordSentSchema, { ...sent, [key]: "" }).success,
			).toBe(false);
		},
	);

	it("必須項目の欠落を拒否する", () => {
		const { channel_id: _omit, ...rest } = sent;
		expect(v.safeParse(discordSentSchema, rest).success).toBe(false);
	});
});

describe("gatewayResponseSchema partner_message_id", () => {
	it("reply は partner_message_id を持てる", () => {
		const r = v.safeParse(gatewayResponseSchema, {
			action: "reply",
			content: "やあ",
			messages: [{ content: "やあ", partner_message_id: "partner:abc" }],
		});
		expect(r.success).toBe(true);
	});

	it("空の partner_message_id は拒否する", () => {
		const r = v.safeParse(gatewayResponseSchema, {
			action: "reply",
			content: "やあ",
			messages: [{ content: "やあ", partner_message_id: "" }],
		});
		expect(r.success).toBe(false);
	});
});

const values = {
	engine: "aivoice",
	preset: "紲星あかり",
	presetOverrides: { Styles: [{ Name: "J", Value: 0.5 }] },
	masterOverrides: {
		Volume: 1,
		Speed: 1,
		Pitch: 1,
		PitchRange: 1,
		MiddlePause: 150,
		LongPause: 370,
		SentencePause: 800,
	},
};

describe("author_voice_channel_id", () => {
	it("省略されたら null にする", () => {
		const r = toInboundMessage(valid());
		expect(r.ok && r.value.authorVoiceChannelId).toBeNull();
	});

	it("VC にいる作者の channel id を受ける", () => {
		const e = valid();
		const r = toInboundMessage({
			...e,
			payload: { ...e.payload, author_voice_channel_id: "77" },
		});
		expect(r.ok && r.value.authorVoiceChannelId).toBe("77");
	});

	it("null を受理する", () => {
		const e = valid();
		const r = toInboundMessage({
			...e,
			payload: { ...e.payload, author_voice_channel_id: null },
		});
		expect(r.ok && r.value.authorVoiceChannelId).toBeNull();
	});
});

describe("gatewayResponseSchema voice", () => {
	const ok = (x: unknown) => v.safeParse(gatewayResponseSchema, x).success;
	it("voice 無しの ack は有効のまま", () => {
		expect(ok({ action: "ack" })).toBe(true);
	});
	it("ack と reply は voice を持てる", () => {
		const voice = {
			join: { guild_id: "1", channel_id: "7" },
			leave: { guild_id: "1" },
			speak: { channel_id: "7", text: "やあ", values },
			speak_queue: [
				{ channel_id: "7", text: "やあ", values },
				{ channel_id: "7", text: "元気ですか", values },
			],
		};
		expect(ok({ action: "ack", voice })).toBe(true);
		expect(ok({ action: "reply", content: "やあ", voice })).toBe(true);
		expect(ok({ action: "ack", voice: {} })).toBe(true);
	});
	it("speak_queue が空配列、text が空、values が欠けると拒否する", () => {
		expect(ok({ action: "ack", voice: { speak_queue: [] } })).toBe(false);
		expect(
			ok({
				action: "ack",
				voice: { speak: { channel_id: "7", text: "", values } },
			}),
		).toBe(false);
		expect(
			ok({
				action: "ack",
				voice: { speak_queue: [{ channel_id: "7", text: "やあ" }] },
			}),
		).toBe(false);
	});
});

describe("toVoiceStateUpdate", () => {
	const event = () => ({
		event_id: newId(),
		type: "discord.voice_state.updated",
		source: "discord",
		partner_id: "yukarin",
		occurred_at: "2026-01-01T00:00:00.000Z",
		received_at: "2026-01-01T00:00:01.000Z",
		schema_version: 1,
		payload: {
			guild_id: "1",
			user: { id: "4", display_name: "alice", is_bot: false },
			from_channel_id: null,
			to_channel_id: "7",
			humans_in_from: 0,
			humans_in_to: 1,
			partner_channel_id: null,
			humans_in_partner_channel: 0,
		},
	});

	it("正常な payload を内部型へ変換する", () => {
		const r = toVoiceStateUpdate(event());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value).toMatchObject({
			guildId: "1",
			user: { id: "4", displayName: "alice", isBot: false },
			fromChannelId: null,
			toChannelId: "7",
			humansInTo: 1,
			partnerChannelId: null,
		});
	});

	it("type と人数の不正を拒否する", () => {
		expect(toVoiceStateUpdate({ ...event(), type: "x" }).ok).toBe(false);
		const e = event();
		expect(
			toVoiceStateUpdate({
				...e,
				payload: { ...e.payload, humans_in_to: -1 },
			}).ok,
		).toBe(false);
	});
});

describe("voiceResponseSchema", () => {
	const ok = (x: unknown) => v.safeParse(voiceResponseSchema, x).success;
	it("join / leave / ignore を受理する", () => {
		expect(ok({ action: "voice_join", guild_id: "1", channel_id: "7" })).toBe(
			true,
		);
		expect(ok({ action: "voice_leave", guild_id: "1" })).toBe(true);
		expect(ok({ action: "ignore" })).toBe(true);
		expect(ok({ action: "voice_join", guild_id: "1" })).toBe(false);
	});
});

describe("discordVoiceConnectionSchema", () => {
	const ok = (x: unknown) =>
		v.safeParse(discordVoiceConnectionSchema, x).success;
	it("接続先は channel id か null", () => {
		expect(ok({ guild_id: "1", channel_id: "7" })).toBe(true);
		expect(ok({ guild_id: "1", channel_id: null })).toBe(true);
		expect(ok({ guild_id: "1" })).toBe(false);
		expect(ok({ guild_id: "1", channel_id: "" })).toBe(false);
	});
});
