import { err, ok } from "@yunomi/core";
import { describe, expect, it, vi } from "vitest";
import { createMessageHandler } from "./handler.ts";
import { silentLogger } from "./logger.ts";
import type { MessageLike } from "./to-envelope.ts";

const message: MessageLike = {
	id: "3",
	guildId: "1",
	channelId: "2",
	content: "hi",
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	author: { id: "4", bot: false, displayName: "alice" },
	mentionedUserIds: [],
	mentionsBotRole: false,
	replyToMessageId: null,
	authorVoiceChannelId: null,
	attachments: [],
};

const setup = (send: (e: unknown) => Promise<unknown>) => {
	const voice = { apply: vi.fn(async (_d: unknown) => {}) };
	const channel = {
		lastMessageId: "3" as string | null | undefined,
		send: vi.fn(async (_o: unknown) => ({ id: "500" })),
	};
	const client = {
		send: vi.fn(send),
		notifySent: vi.fn(
			async (..._a: unknown[]) => ok({ bound: true }) as unknown,
		),
	};
	const logger = { ...silentLogger, warn: vi.fn() };
	const handle = createMessageHandler({
		client: client as never,
		partnerId: "yukarin",
		botUserId: "999",
		voice,
		logger,
	});
	return { channel, client, handle, logger, voice };
};

describe("createMessageHandler", () => {
	it("reply は allowedMentions parse=[] と返信先つきで送る", async () => {
		const { channel, handle } = setup(async () =>
			ok({
				action: "reply",
				content: "やあ @everyone",
				reply_to_message_id: "3",
			}),
		);
		channel.lastMessageId = "9";
		await handle(message, channel);
		expect(channel.send).toHaveBeenCalledWith({
			content: "やあ @everyone",
			reply: { messageReference: "3", failIfNotExists: false },
			allowedMentions: { repliedUser: false, parse: [] },
		});
	});

	it("直近の発言が宛先なら返信形式にせず普通に送る", async () => {
		const { channel, handle } = setup(async () =>
			ok({ action: "reply", content: "やあ" }),
		);
		await handle(message, channel);
		expect(channel.send).toHaveBeenCalledWith({
			content: "やあ",
			allowedMentions: { repliedUser: false, parse: [] },
		});
	});

	it("reply_to が無ければ元メッセージに返信する", async () => {
		const { channel, handle } = setup(async () =>
			ok({ action: "reply", content: "やあ" }),
		);
		channel.lastMessageId = "9";
		await handle(message, channel);
		expect(channel.send.mock.calls[0]?.[0]).toMatchObject({
			reply: { messageReference: "3" },
		});
	});

	it("送信後に partner 発言の Discord message id を通知する", async () => {
		const { channel, client, handle } = setup(async () =>
			ok({ action: "reply", content: "やあ", partner_message_id: "partner:x" }),
		);
		await handle(message, channel);
		expect(client.notifySent).toHaveBeenCalledWith("yukarin", {
			partner_message_id: "partner:x",
			channel_id: "2",
			discord_message_id: "500",
		});
	});

	it("partner_message_id が無い reply は通知しない", async () => {
		const { channel, client, handle } = setup(async () =>
			ok({ action: "reply", content: "やあ" }),
		);
		await handle(message, channel);
		expect(client.notifySent).not.toHaveBeenCalled();
	});

	it("通知が失敗しても handler は落ちない", async () => {
		const { channel, client, handle } = setup(async () =>
			ok({ action: "reply", content: "やあ", partner_message_id: "partner:x" }),
		);
		client.notifySent.mockResolvedValueOnce(
			err({ type: "ExternalServiceUnavailable" }),
		);
		await expect(handle(message, channel)).resolves.toBeUndefined();
		client.notifySent.mockRejectedValueOnce(new Error("boom"));
		await expect(handle(message, channel)).resolves.toBeUndefined();
		expect(client.notifySent).toHaveBeenCalledTimes(2);
	});

	it("Worker が partner 発言を結び付けられなかったら warn を残す", async () => {
		const { channel, client, handle, logger } = setup(async () =>
			ok({ action: "reply", content: "やあ", partner_message_id: "partner:x" }),
		);
		client.notifySent.mockResolvedValueOnce(ok({ bound: false }));
		await handle(message, channel);
		expect(logger.warn).toHaveBeenCalledWith(
			"sent notification not bound",
			expect.objectContaining({ sent_message_id: "500" }),
		);
	});

	it("Discord への送信が失敗したら通知しない", async () => {
		const { channel, client, handle } = setup(async () =>
			ok({ action: "reply", content: "やあ", partner_message_id: "partner:x" }),
		);
		channel.send.mockRejectedValueOnce(new Error("missing access"));
		await handle(message, channel);
		expect(client.notifySent).not.toHaveBeenCalled();
	});

	it("ignore と ack は何も送らず、通知もしない", async () => {
		for (const action of ["ignore", "ack"]) {
			const { channel, client, handle } = setup(async () => ok({ action }));
			await handle(message, channel);
			expect(channel.send).not.toHaveBeenCalled();
			expect(client.notifySent).not.toHaveBeenCalled();
		}
	});

	it("失敗しても何も送らない", async () => {
		const { channel, handle } = setup(async () =>
			err({ type: "ExternalServiceUnavailable" }),
		);
		await handle(message, channel);
		expect(channel.send).not.toHaveBeenCalled();
	});

	it("自分の発言は中継しない", async () => {
		const { channel, client, handle } = setup(async () =>
			ok({ action: "ignore" }),
		);
		await handle(
			{ ...message, author: { id: "999", bot: true, displayName: "me" } },
			channel,
		);
		expect(client.send).not.toHaveBeenCalled();
	});

	it("ack の voice 指示を VoiceManager に渡す", async () => {
		const voice = { join: { guild_id: "1", channel_id: "vc" } };
		const {
			channel,
			handle,
			voice: manager,
		} = setup(async () => ok({ action: "ack", voice }));
		await handle(message, channel);
		expect(manager.apply).toHaveBeenCalledWith(voice);
		expect(channel.send).not.toHaveBeenCalled();
	});

	it("reply の voice 指示も渡し、テキストの返信も送る", async () => {
		const voice = { leave: { guild_id: "1" } };
		const {
			channel,
			handle,
			voice: manager,
		} = setup(async () => ok({ action: "reply", content: "やあ", voice }));
		await handle(message, channel);
		expect(manager.apply).toHaveBeenCalledWith(voice);
		expect(channel.send).toHaveBeenCalledTimes(1);
	});

	it("ignore では VC を操作しない", async () => {
		const {
			channel,
			handle,
			voice: manager,
		} = setup(async () => ok({ action: "ignore" }));
		await handle(message, channel);
		expect(manager.apply).not.toHaveBeenCalled();
	});

	it("VC の操作が失敗しても返信は送る", async () => {
		const {
			channel,
			handle,
			voice: manager,
		} = setup(async () =>
			ok({
				action: "reply",
				content: "やあ",
				voice: { leave: { guild_id: "1" } },
			}),
		);
		manager.apply.mockRejectedValueOnce(new Error("boom"));
		await handle(message, channel);
		expect(channel.send).toHaveBeenCalledTimes(1);
	});
});
