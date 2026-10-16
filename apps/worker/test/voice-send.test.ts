import { runInDurableObject } from "cloudflare:test";
import {
	type CommunicationPort,
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
	type SentMessage,
	type SpeechResult,
} from "@yunomi/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoStore } from "../src/do/store.ts";
import { VOICE_DEADLINE_MS, VOICE_POLL_MS } from "../src/do/voice.ts";
import type { VoiceOrgans } from "../src/voice-organs.ts";
import {
	installFakeLlm,
	llmOk,
	mention,
	newScenario,
	send,
	turn,
} from "./e2e/harness.ts";
import { PARTNER_ID, partnerStub } from "./helpers.ts";

// DO の alarm は実時刻で発火する。過去の時刻に予約すると即座に自走し、
// テストが runAlarm で進める前に pending と alarm を消すので、実時刻より先に置く。
const CLOCK0 = new Date("2100-01-01T00:00:00Z");

type Availability = "ready" | "asleep" | "waking" | "unreachable";

const fakePort = () => ({
	sendText: vi.fn(
		async (): Promise<Result<SentMessage, DomainError>> =>
			ok({ messageId: "d-500" }),
	),
	sendTyping: vi.fn(async () => ok(undefined)),
	sendAttachment: vi.fn(async (_i: unknown) => ok({ messageId: "d-600" })),
});

const fakeOrgans = (state: { availability: Availability }) => {
	const synthesize = vi.fn(
		async (): Promise<Result<SpeechResult, DomainError>> =>
			ok({
				audio: new Uint8Array([1, 2, 3]),
				contentType: "audio/wav",
				durationMs: 100,
			}),
	);
	const wake = vi.fn(
		async (): Promise<Result<void, DomainError>> => ok(undefined),
	);
	const organs: VoiceOrgans = {
		speech: { synthesize },
		checkAvailability: async (at) => ({
			organId: "ochoko",
			availability: state.availability,
			checkedAt: at.toISOString(),
		}),
		wake,
	};
	return { organs, synthesize, wake };
};

const install = (
	port: CommunicationPort | null,
	organs: VoiceOrgans | null,
	now: Date = CLOCK0,
) =>
	runInDurableObject(partnerStub(PARTNER_ID), (o) => {
		o.createCommunication = () => port;
		o.createVoiceOrgans = () => organs;
		o.now = () => now;
	});

const runAlarm = (now: Date) =>
	runInDurableObject(partnerStub(PARTNER_ID), async (o) => {
		o.now = () => now;
		await o.alarm();
		await o.flushBackground();
	});

afterEach(async () => {
	await install(null, null);
	await runInDurableObject(partnerStub(PARTNER_ID), async (_o, st) => {
		await st.storage.deleteAlarm();
		const keys = [...(await st.storage.list({ prefix: "voice:" })).keys()];
		await st.storage.delete(keys);
	});
});

const speakAloud = (over = {}) =>
	turn({ utterance: "おはよう", speak_aloud: true, ...over });

describe("声の添付", () => {
	it("テキストの返事に続けて、その返信として WAV を添付する", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(speakAloud())]);
		const port = fakePort();
		const o = fakeOrgans({ availability: "ready" });
		await install(port, o.organs);

		expect(await send(mention(s))).toEqual({ action: "ack" });

		expect(port.sendText).toHaveBeenCalledTimes(1);
		expect(o.synthesize).toHaveBeenCalledTimes(1);
		expect(port.sendAttachment).toHaveBeenCalledWith({
			channelId: s.channelId,
			filename: "voice.wav",
			contentType: "audio/wav",
			data: new Uint8Array([1, 2, 3]),
		});
	});

	it("IR からプロファイルの preset と Styles を作って合成に渡す", async () => {
		const s = newScenario();
		await installFakeLlm([
			llmOk(
				speakAloud({
					performance: {
						emotion: "joy",
						energy: 1,
						pace: "normal",
						warmth: 0.5,
						pause_before_ms: 0,
					},
				}),
			),
		]);
		const o = fakeOrgans({ availability: "ready" });
		await install(fakePort(), o.organs);

		await send(mention(s));

		const request = o.synthesize.mock.calls[0] as unknown as [
			{ text: string; values: { preset: string; presetOverrides: unknown } },
		];
		expect(request[0].text).toBe("おはよう");
		expect(request[0].values.preset).toBe("結月 ゆかり");
		expect(request[0].values.presetOverrides).toMatchObject({
			Styles: expect.arrayContaining([{ Name: "J", Value: 0.7 }]),
		});
	});

	it("speak_aloud が false なら声にしない", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(turn({ speak_aloud: false }))]);
		const port = fakePort();
		const o = fakeOrgans({ availability: "ready" });
		await install(port, o.organs);

		await send(mention(s));

		expect(port.sendText).toHaveBeenCalled();
		expect(o.synthesize).not.toHaveBeenCalled();
		expect(port.sendAttachment).not.toHaveBeenCalled();
	});

	it("声が無効なら声にせず、脳には声を出せないと伝える", async () => {
		const s = newScenario();
		const fake = await installFakeLlm([llmOk(speakAloud())]);
		const port = fakePort();
		await install(port, null);

		await send(mention(s));

		expect(port.sendText).toHaveBeenCalled();
		expect(port.sendAttachment).not.toHaveBeenCalled();
		expect(JSON.stringify(fake.requests[0]?.system)).toContain(
			"今は声を出せない",
		);
	});

	it("寝ていた器官の状態を脳に渡す", async () => {
		const s = newScenario();
		const fake = await installFakeLlm([llmOk(turn())]);
		await install(fakePort(), fakeOrgans({ availability: "asleep" }).organs);

		await send(mention(s));

		expect(JSON.stringify(fake.requests[0]?.system)).toContain("眠っている");
	});

	it("寝ていたら起こし、alarm で ready を待って添付する", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(speakAloud())]);
		const port = fakePort();
		const state = { availability: "asleep" as Availability };
		const o = fakeOrgans(state);
		await install(port, o.organs);

		await send(mention(s));

		expect(port.sendText).toHaveBeenCalledTimes(1);
		expect(o.wake).toHaveBeenCalledTimes(1);
		expect(port.sendAttachment).not.toHaveBeenCalled();
		const alarm = await runInDurableObject(partnerStub(PARTNER_ID), (_o, st) =>
			st.storage.getAlarm(),
		);
		expect(alarm).not.toBeNull();

		state.availability = "waking";
		await runAlarm(new Date(CLOCK0.getTime() + VOICE_POLL_MS));
		expect(port.sendAttachment).not.toHaveBeenCalled();

		state.availability = "ready";
		await runAlarm(new Date(CLOCK0.getTime() + VOICE_POLL_MS * 2));
		expect(port.sendAttachment).toHaveBeenCalledTimes(1);
		expect(port.sendAttachment).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: s.channelId }),
		);
		expect(port.sendAttachment.mock.calls[0]?.[0]).not.toHaveProperty(
			"replyToMessageId",
		);

		await runAlarm(new Date(CLOCK0.getTime() + VOICE_POLL_MS * 3));
		expect(port.sendAttachment).toHaveBeenCalledTimes(1);
	});

	it("待つあいだに他の発言が入れば、返信形式で添付する", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(speakAloud())]);
		const port = fakePort();
		const state = { availability: "asleep" as Availability };
		const o = fakeOrgans(state);
		await install(port, o.organs);

		await send(mention(s));
		await runInDurableObject(partnerStub(PARTNER_ID), (_o, st) => {
			new DoStore(st.storage.sql).appendRecent({
				channelId: s.channelId,
				messageId: "later-1",
				authorId: "u-other",
				authorName: "bob",
				isBot: false,
				isPartner: false,
				content: "割り込み",
				occurredAt: "2026-10-11T03:00:00.000Z",
			});
		});

		state.availability = "ready";
		await runAlarm(new Date(CLOCK0.getTime() + VOICE_POLL_MS));
		expect(port.sendAttachment).toHaveBeenCalledWith(
			expect.objectContaining({
				channelId: s.channelId,
				replyToMessageId: "d-500",
			}),
		);
	});

	it("2 分で ready にならなければ声を諦め、テキストは届いている", async () => {
		const s = newScenario();
		const fake = await installFakeLlm([llmOk(speakAloud()), llmOk(turn())]);
		const port = fakePort();
		const state = { availability: "asleep" as Availability };
		const o = fakeOrgans(state);
		await install(port, o.organs);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		await send(mention(s));
		const late = new Date(CLOCK0.getTime() + VOICE_DEADLINE_MS);
		await runAlarm(late);

		expect(port.sendText).toHaveBeenCalledTimes(1);
		expect(port.sendAttachment).not.toHaveBeenCalled();
		expect(o.synthesize).not.toHaveBeenCalled();

		await install(port, o.organs, late);
		await send(mention(s));
		expect(JSON.stringify(fake.requests[1]?.system)).toContain(
			"今は声を出せない",
		);
	});

	it("合成や添付が失敗してもテキストの返事は失われない", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(speakAloud())]);
		const port = fakePort();
		const o = fakeOrgans({ availability: "ready" });
		o.synthesize.mockResolvedValue(
			err(externalServiceUnavailable({ service: "ochoko" })),
		);
		await install(port, o.organs);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(await send(mention(s))).toEqual({ action: "ack" });
		expect(port.sendText).toHaveBeenCalledTimes(1);
		expect(port.sendAttachment).not.toHaveBeenCalled();
	});

	it("送信に失敗した返事には声を付けない", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(speakAloud())]);
		const port = fakePort();
		port.sendText.mockResolvedValueOnce(
			err(externalServiceUnavailable({ service: "discord" })),
		);
		const o = fakeOrgans({ availability: "ready" });
		await install(port, o.organs);
		vi.spyOn(console, "error").mockImplementation(() => {});

		await send(mention(s));

		expect(o.synthesize).not.toHaveBeenCalled();
	});
});
