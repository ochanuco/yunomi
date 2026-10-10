import { err, ok } from "@yunomi/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessageHandler, TYPING_INTERVAL_MS } from "./handler.ts";
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
	attachments: [],
};

const setup = (send: (e: unknown) => Promise<unknown>) => {
	const channel = {
		sendTyping: vi.fn(async () => {}),
		send: vi.fn(async (_o: unknown) => ({ id: "500" })),
	};
	const client = {
		send: vi.fn(send),
		notifySent: vi.fn(async (..._a: unknown[]) => ok(undefined) as unknown),
	};
	const handle = createMessageHandler({
		client: client as never,
		partnerId: "yukarin",
		botUserId: "999",
		logger: silentLogger,
	});
	return { channel, client, handle };
};

afterEach(() => vi.useRealTimers());

describe("createMessageHandler", () => {
	it("reply は allowedMentions parse=[] と返信先つきで送る", async () => {
		const { channel, handle } = setup(async () =>
			ok({
				action: "reply",
				content: "やあ @everyone",
				reply_to_message_id: "3",
			}),
		);
		await handle(message, channel);
		expect(channel.send).toHaveBeenCalledWith({
			content: "やあ @everyone",
			reply: { messageReference: "3", failIfNotExists: false },
			allowedMentions: { repliedUser: false, parse: [] },
		});
	});

	it("reply_to が無ければ元メッセージに返信する", async () => {
		const { channel, handle } = setup(async () =>
			ok({ action: "reply", content: "やあ" }),
		);
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

	it("Discord への送信が失敗したら通知しない", async () => {
		const { channel, client, handle } = setup(async () =>
			ok({ action: "reply", content: "やあ", partner_message_id: "partner:x" }),
		);
		channel.send.mockRejectedValueOnce(new Error("missing access"));
		await handle(message, channel);
		expect(client.notifySent).not.toHaveBeenCalled();
	});

	it("ignore は何も送らず、typing は開始される", async () => {
		const { channel, handle } = setup(async () => ok({ action: "ignore" }));
		await handle(message, channel);
		expect(channel.send).not.toHaveBeenCalled();
		expect(channel.sendTyping).toHaveBeenCalledTimes(1);
	});

	it("失敗しても何も送らない", async () => {
		const { channel, handle } = setup(async () =>
			err({ type: "ExternalServiceUnavailable" }),
		);
		await handle(message, channel);
		expect(channel.send).not.toHaveBeenCalled();
	});

	it("待機中は 8 秒ごとに typing を出し、完了後は止める", async () => {
		vi.useFakeTimers();
		let release: (v: unknown) => void = () => {};
		const { channel, handle } = setup(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const done = handle(message, channel);
		expect(channel.sendTyping).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS * 2);
		expect(channel.sendTyping).toHaveBeenCalledTimes(3);
		release(ok({ action: "ignore" }));
		await done;
		await vi.advanceTimersByTimeAsync(TYPING_INTERVAL_MS * 3);
		expect(channel.sendTyping).toHaveBeenCalledTimes(3);
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
		expect(channel.sendTyping).not.toHaveBeenCalled();
	});
});
