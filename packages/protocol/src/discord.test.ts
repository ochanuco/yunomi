import { newId } from "@yunomi/core";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
	dedupeKey,
	gatewayResponseSchema,
	toInboundMessage,
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
	it("reply / ignore を受理する", () => {
		expect(ok({ action: "reply", content: "やあ" })).toBe(true);
		expect(
			ok({ action: "reply", content: "やあ", reply_to_message_id: "3" }),
		).toBe(true);
		expect(ok({ action: "ignore" })).toBe(true);
	});
	it("空・2000 文字超・未知の action を拒否する", () => {
		expect(ok({ action: "reply", content: "" })).toBe(false);
		expect(ok({ action: "reply", content: "a".repeat(2001) })).toBe(false);
		expect(ok({ action: "reply", content: "a".repeat(2000) })).toBe(true);
		expect(ok({ action: "dm" })).toBe(false);
	});
});
