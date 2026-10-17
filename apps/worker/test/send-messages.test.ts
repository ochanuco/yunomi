import { ok } from "@yunomi/core";
import { describe, expect, it, vi } from "vitest";
import {
	MESSAGE_GAP_MAX_MS,
	messageGapMs,
	messageNonce,
	sendMessages,
} from "../src/do/send-messages.ts";

describe("messageGapMs", () => {
	it("600ms に 1 文字 40ms を足し、2500ms で頭打ちにする", () => {
		expect(messageGapMs("")).toBe(600);
		expect(messageGapMs("はい")).toBe(680);
		expect(messageGapMs("あ".repeat(100))).toBe(MESSAGE_GAP_MAX_MS);
	});
});

describe("messageNonce", () => {
	it("同じ入力と番号なら同じ値で、番号ごとに違い、25 文字に収まる", () => {
		const id = "12345678901234567890";
		expect(messageNonce(id, 0)).toBe(messageNonce(id, 0));
		expect(messageNonce(id, 0)).not.toBe(messageNonce(id, 1));
		expect(messageNonce(id, 9).length).toBeLessThanOrEqual(25);
		expect(messageNonce("x".repeat(40), 3)).toMatch(/:3$/);
		expect(messageNonce("x".repeat(40), 3)).toHaveLength(25);
	});
});

describe("sendMessages", () => {
	const port = () => ({
		sendText: vi.fn(async (i: { text: string }) =>
			ok({ messageId: `d-${i.text}` }),
		),
		sendTyping: vi.fn(async () => ok(undefined)),
		sendAttachment: vi.fn(),
	});
	const messages = ["a", "b", "c"].map((text, i) => ({
		text,
		nonce: `n:${i}`,
	}));

	it("stopBefore が true を返したら、そのメッセージから先を送らない", async () => {
		const p = port();
		const onSent = vi.fn();
		const r = await sendMessages(
			{
				port: p,
				channelId: "c",
				sleep: async () => {},
				onSent,
				stopBefore: (i) => i === 2,
			},
			messages,
		);
		expect(r).toEqual({
			sentIds: ["d-a", "d-b"],
			end: { type: "stopped", at: 2 },
		});
		expect(onSent.mock.calls).toEqual([
			[0, "d-a"],
			[1, "d-b"],
		]);
	});

	it("1 件だけなら待たず、入力中も出さない", async () => {
		const p = port();
		const sleep = vi.fn(async () => {});
		const r = await sendMessages(
			{ port: p, channelId: "c", sleep, onSent: () => {} },
			messages.slice(0, 1),
		);
		expect(r).toEqual({ sentIds: ["d-a"], end: { type: "done" } });
		expect(sleep).not.toHaveBeenCalled();
		expect(p.sendTyping).not.toHaveBeenCalled();
	});
});
