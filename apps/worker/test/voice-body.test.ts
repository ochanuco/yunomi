import {
	type Availability,
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
	type SentMessage,
	type SpeechRequest,
	type SpeechResult,
	validationFailed,
} from "@yunomi/core";
import { describe, expect, it, vi } from "vitest";
import {
	ORGAN_MAX_AGE_MS,
	type SpeechJob,
	VOICE_DEADLINE_MS,
	VOICE_POLL_MS,
	VoiceBody,
	type VoiceStorage,
} from "../src/do/voice.ts";
import type { VoiceOrgans } from "../src/voice-organs.ts";

const memoryStorage = () => {
	const map = new Map<string, unknown>();
	return {
		map,
		storage: {
			get: async (key: string) => map.get(key),
			put: async (key: string, value: unknown) => {
				map.set(key, value);
			},
			delete: async (key: string) => map.delete(key),
			list: async (opts: { prefix: string }) =>
				new Map([...map].filter(([k]) => k.startsWith(opts.prefix))),
		} as unknown as VoiceStorage,
	};
};

const T0 = new Date("2026-10-11T03:00:00Z");

const job: SpeechJob = {
	messageId: "d-500",
	channelId: "c1",
	text: "おはよう",
	values: {
		engine: "aivoice",
		preset: "結月 ゆかり",
		presetOverrides: { Styles: [] },
		masterOverrides: {
			Volume: 1,
			Speed: 1,
			Pitch: 1,
			PitchRange: 1,
			MiddlePause: 150,
			LongPause: 370,
			SentencePause: 800,
		},
	},
};

const setup = () => {
	const { map, storage } = memoryStorage();
	let now = T0;
	const state = { availability: "ready" as Availability };
	const synthesize = vi.fn(
		async (_r: SpeechRequest): Promise<Result<SpeechResult, DomainError>> =>
			ok({
				audio: new Uint8Array([1, 2, 3]),
				contentType: "audio/wav",
				durationMs: 500,
			}),
	);
	const wake = vi.fn(
		async (): Promise<Result<void, DomainError>> => ok(undefined),
	);
	const checkAvailability = vi.fn(async (at: Date) => ({
		organId: "ochoko",
		availability: state.availability,
		checkedAt: at.toISOString(),
	}));
	const organs: VoiceOrgans = {
		speech: { synthesize },
		checkAvailability,
		wake,
	};
	const sendAttachment = vi.fn(
		async (): Promise<Result<SentMessage, DomainError>> =>
			ok({ messageId: "d-600" }),
	);
	const setAlarm = vi.fn(async (_at: Date) => {});
	const body = new VoiceBody({
		storage,
		organs,
		communication: {
			sendText: vi.fn(),
			sendTyping: vi.fn(),
			sendAttachment,
		},
		now: () => now,
		setAlarm,
	});
	return {
		body,
		map,
		state,
		synthesize,
		wake,
		checkAvailability,
		sendAttachment,
		setAlarm,
		advance: (ms: number) => {
			now = new Date(now.getTime() + ms);
		},
	};
};

describe("VoiceBody.speak", () => {
	it("ready なら合成して、返事への返信として添付する", async () => {
		const t = setup();
		await t.body.speak(job);

		expect(t.synthesize).toHaveBeenCalledWith({
			text: "おはよう",
			values: job.values,
		});
		expect(t.sendAttachment).toHaveBeenCalledWith({
			channelId: "c1",
			replyToMessageId: "d-500",
			filename: "voice.wav",
			contentType: "audio/wav",
			data: new Uint8Array([1, 2, 3]),
		});
		expect(t.wake).not.toHaveBeenCalled();
		expect(t.setAlarm).not.toHaveBeenCalled();
	});

	it("寝ていたら起こして待たせ、alarm で ready になったら添付する", async () => {
		const t = setup();
		t.state.availability = "asleep";
		await t.body.speak(job);

		expect(t.wake).toHaveBeenCalledTimes(1);
		expect(t.sendAttachment).not.toHaveBeenCalled();
		expect(t.setAlarm).toHaveBeenLastCalledWith(
			new Date(T0.getTime() + VOICE_POLL_MS),
		);
		expect(t.map.get("voice:pending:d-500")).toMatchObject({
			messageId: "d-500",
			channelId: "c1",
			text: "おはよう",
			deadline: new Date(T0.getTime() + VOICE_DEADLINE_MS).toISOString(),
		});

		t.advance(VOICE_POLL_MS);
		t.state.availability = "waking";
		await t.body.poll();
		expect(t.sendAttachment).not.toHaveBeenCalled();
		expect(t.setAlarm).toHaveBeenCalledTimes(2);

		t.advance(VOICE_POLL_MS);
		t.state.availability = "ready";
		await t.body.poll();
		expect(t.sendAttachment).toHaveBeenCalledTimes(1);
		expect(t.map.has("voice:pending:d-500")).toBe(false);
		expect(t.setAlarm).toHaveBeenCalledTimes(2);
	});

	it("起きかけなら wake を重ねず待つ", async () => {
		const t = setup();
		t.state.availability = "waking";
		await t.body.speak(job);
		expect(t.wake).not.toHaveBeenCalled();
		expect(t.map.has("voice:pending:d-500")).toBe(true);
	});

	it("使えない器官には何もしない", async () => {
		for (const availability of ["unavailable", "unreachable"] as const) {
			const t = setup();
			t.state.availability = availability;
			await t.body.speak(job);
			expect(t.wake).not.toHaveBeenCalled();
			expect(t.map.has("voice:pending:d-500")).toBe(false);
			expect(t.sendAttachment).not.toHaveBeenCalled();
		}
	});

	it("wake に失敗したら待たずに諦める", async () => {
		const t = setup();
		t.state.availability = "asleep";
		t.wake.mockResolvedValueOnce(
			err(externalServiceUnavailable({ service: "wol" })),
		);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		await t.body.speak(job);
		expect(t.map.has("voice:pending:d-500")).toBe(false);
		expect(await t.body.bodyState()).toBe("unavailable");
	});

	it("合成が一時的に失敗したら待ちに回して再試行する", async () => {
		const t = setup();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		t.synthesize.mockResolvedValueOnce(
			err(externalServiceUnavailable({ service: "ochoko" })),
		);
		await t.body.speak(job);
		expect(t.sendAttachment).not.toHaveBeenCalled();
		expect(t.map.has("voice:pending:d-500")).toBe(true);

		t.advance(VOICE_POLL_MS);
		await t.body.poll();
		expect(t.sendAttachment).toHaveBeenCalledTimes(1);
	});

	it("合成の失敗が続くと再試行を打ち切る", async () => {
		const t = setup();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		t.synthesize.mockResolvedValue(
			err(externalServiceUnavailable({ service: "ochoko" })),
		);
		await t.body.speak(job);
		for (let i = 0; i < 5; i++) {
			t.advance(VOICE_POLL_MS);
			await t.body.poll();
		}
		expect(t.synthesize.mock.calls.length).toBeLessThanOrEqual(3);
		expect(t.map.has("voice:pending:d-500")).toBe(false);
	});

	it("再試行できない失敗は待ちに回さない", async () => {
		const t = setup();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		t.synthesize.mockResolvedValueOnce(
			err(validationFailed({ issues: ["x"] })),
		);
		await t.body.speak(job);
		expect(t.map.has("voice:pending:d-500")).toBe(false);
	});

	it("添付に失敗しても重ねて送らない", async () => {
		const t = setup();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		t.sendAttachment.mockResolvedValueOnce(
			err(externalServiceUnavailable({ service: "discord" })),
		);
		await t.body.speak(job);
		t.advance(VOICE_POLL_MS);
		await t.body.poll();
		expect(t.sendAttachment).toHaveBeenCalledTimes(1);
	});
});

describe("VoiceBody.poll", () => {
	it("期限まで ready にならなければ声を諦め、身体の状態を unavailable にする", async () => {
		const t = setup();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		t.state.availability = "asleep";
		await t.body.speak(job);

		t.advance(VOICE_DEADLINE_MS - 1);
		await t.body.poll();
		expect(t.map.has("voice:pending:d-500")).toBe(true);

		t.advance(1);
		await t.body.poll();
		expect(t.map.has("voice:pending:d-500")).toBe(false);
		expect(t.sendAttachment).not.toHaveBeenCalled();
		expect(t.setAlarm).toHaveBeenCalledTimes(2);
		expect(await t.body.bodyState()).toBe("unavailable");
	});

	it("alarm が重なっても添付は 1 回", async () => {
		const t = setup();
		t.state.availability = "asleep";
		await t.body.speak(job);
		t.state.availability = "ready";
		t.advance(VOICE_POLL_MS);

		await Promise.all([t.body.poll(), t.body.poll()]);

		expect(t.sendAttachment).toHaveBeenCalledTimes(1);
	});

	it("待ちがなければ可用性を確かめない", async () => {
		const t = setup();
		await t.body.poll();
		expect(t.checkAvailability).not.toHaveBeenCalled();
	});
});

describe("VoiceBody.bodyState", () => {
	it("可用性を身体の状態にする", async () => {
		for (const [availability, expected] of [
			["ready", "can_speak"],
			["asleep", "asleep"],
			["waking", "waking"],
			["unavailable", "unavailable"],
			["unreachable", "unavailable"],
		] as const) {
			const t = setup();
			t.state.availability = availability;
			expect(await t.body.bodyState()).toBe(expected);
		}
	});

	it("60 秒以内は保存した値を使い、過ぎたら取り直す", async () => {
		const t = setup();
		expect(await t.body.bodyState()).toBe("can_speak");
		t.state.availability = "asleep";
		t.advance(ORGAN_MAX_AGE_MS);
		expect(await t.body.bodyState()).toBe("can_speak");
		expect(t.checkAvailability).toHaveBeenCalledTimes(1);

		t.advance(1);
		expect(await t.body.bodyState()).toBe("asleep");
		expect(t.checkAvailability).toHaveBeenCalledTimes(2);
	});

	it("確認に失敗したら unavailable", async () => {
		const t = setup();
		t.checkAvailability.mockRejectedValueOnce(new Error("boom"));
		expect(await t.body.bodyState()).toBe("unavailable");
	});
});
