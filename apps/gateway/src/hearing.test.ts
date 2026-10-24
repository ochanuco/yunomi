import { err, externalServiceUnavailable, ok } from "@yunomi/core";
import { toHeardUtterance } from "@yunomi/protocol";
import { describe, expect, it, vi } from "vitest";
import type { Utterance } from "./ears.ts";
import { createHearing } from "./hearing.ts";
import type { Transcript } from "./kukicha-client.ts";
import { silentLogger } from "./logger.ts";

const where = { guildId: "1", channelId: "2" };

const utterance = (n: number): Utterance => ({
	userId: "42",
	wav: new Uint8Array([n]),
	startedAt: new Date("2026-01-01T00:00:00.000Z"),
	durationMs: 1500,
});

const setup = (
	transcribe: (wav: Uint8Array) => Promise<unknown>,
	response: unknown = ok({
		action: "ack",
		voice: { leave: { guild_id: "1" } },
	}),
) => {
	const kukicha = {
		transcribe: vi.fn(async (r: { wav: Uint8Array; speaker: string }) =>
			transcribe(r.wav),
		),
	};
	const client = {
		send: vi.fn(async (_e: unknown) => response),
		notifySent: vi.fn(async () => ok({ bound: true })),
	};
	const voice = { apply: vi.fn(async (_d: unknown) => {}) };
	const channel = { send: vi.fn(async (_o: unknown) => ({ id: "500" })) };
	const logger = { ...silentLogger, info: vi.fn(), warn: vi.fn() };
	const hear = createHearing({
		kukicha: kukicha as never,
		client: client as never,
		partnerId: "yukarin",
		ownerUserId: "42",
		displayNameOf: () => "持ち主",
		channelOf: () => channel,
		voice,
		now: () => new Date("2026-01-01T00:00:05.000Z"),
		logger,
	});
	return { channel, client, hear, kukicha, logger, voice };
};

const said = (text: string) =>
	ok<Transcript>({ text, durationMs: 1200 }) as unknown;

describe("createHearing", () => {
	it("持ち主の id を speaker にして文字にする", async () => {
		const { hear, kukicha } = setup(async () => said(""));
		await hear(utterance(1), where);
		expect(kukicha.transcribe).toHaveBeenCalledWith({
			wav: new Uint8Array([1]),
			speaker: "42",
		});
	});

	it("空の text は Worker に送らない", async () => {
		const { client, hear } = setup(async () => said("  "));
		await hear(utterance(1), where);
		expect(client.send).not.toHaveBeenCalled();
	});

	it("空でない text は discord.voice.utterance として送り、応答の voice を実行する", async () => {
		const { client, hear, logger, voice } = setup(async () =>
			said("こんにちは"),
		);
		await hear(utterance(1), where);
		const sent = client.send.mock.calls[0]?.[0];
		const heard = toHeardUtterance(sent);
		expect(heard.ok && heard.value).toMatchObject({
			partnerId: "yukarin",
			guildId: "1",
			channelId: "2",
			author: { id: "42", displayName: "持ち主" },
			text: "こんにちは",
			durationMs: 1200,
			occurredAt: new Date("2026-01-01T00:00:00.000Z"),
		});
		expect(voice.apply).toHaveBeenCalledWith({ leave: { guild_id: "1" } });
		// info 以上のログに文字を出さない
		expect(JSON.stringify(logger.info.mock.calls)).not.toContain("こんにちは");
	});

	it("reply は VC のテキストチャットへ返信形式にせず送る", async () => {
		const { channel, hear, voice } = setup(
			async () => said("こんにちは"),
			ok({
				action: "reply",
				content: "やあ",
				voice: { leave: { guild_id: "1" } },
			}),
		);
		await hear(utterance(1), where);
		expect(channel.send).toHaveBeenCalledWith({
			content: "やあ",
			allowedMentions: { repliedUser: false, parse: [] },
		});
		expect(voice.apply).toHaveBeenCalled();
	});

	it("kukicha の失敗は捨てて次の発話に進む", async () => {
		const { client, hear, logger } = setup(async (wav) =>
			wav[0] === 1
				? err(externalServiceUnavailable({ service: "kukicha" }))
				: said("つぎ"),
		);
		await Promise.all([hear(utterance(1), where), hear(utterance(2), where)]);
		expect(logger.warn).toHaveBeenCalledWith(
			"utterance dropped",
			expect.objectContaining({ error: "ExternalServiceUnavailable" }),
		);
		expect(client.send).toHaveBeenCalledTimes(1);
	});

	it("同じ VC の発話は、前の発話の送信が終わってから次を文字にする", async () => {
		const order: string[] = [];
		let release = () => {};
		const { client, hear } = setup(async (wav) => {
			order.push(`stt:${wav[0]}`);
			return said(`発話${wav[0]}`);
		});
		client.send.mockImplementationOnce(async () => {
			order.push("send:1");
			await new Promise<void>((r) => {
				release = r;
			});
			return ok({ action: "ignore" });
		});
		const first = hear(utterance(1), where);
		const second = hear(utterance(2), where);
		await vi.waitFor(() => expect(order).toContain("send:1"));
		expect(order).toEqual(["stt:1", "send:1"]);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["stt:1", "send:1", "stt:2"]);
	});
});
