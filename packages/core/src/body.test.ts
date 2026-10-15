import { describe, expect, it } from "vitest";
import {
	type BodyIntent,
	type CommunicationPort,
	deriveBodyState,
	type OrganAvailability,
	type SpeechPort,
} from "./body.ts";
import { externalServiceUnavailable } from "./errors.ts";
import { err, ok } from "./result.ts";

const intent: BodyIntent = {
	text: "おはようございます",
	performance: {
		emotion: "joy",
		energy: 0.6,
		pace: "normal",
		warmth: 0.8,
		pause_before_ms: 0,
	},
	speakAloud: true,
};

describe("口の型の使い方", () => {
	it("発声の口でテキストと値から音声を得て、意思疎通の口で返信として添付する", async () => {
		const speech: SpeechPort = {
			synthesize: async (req) =>
				req.text === ""
					? err(externalServiceUnavailable({ service: "ochoko" }))
					: ok({
							audio: new Uint8Array([1, 2]),
							contentType: "audio/wav",
							durationMs: 1200,
						}),
		};
		const sent: string[] = [];
		const comm: CommunicationPort = {
			sendText: async () => ok({ messageId: "m1" }),
			sendTyping: async () => ok(undefined),
			sendAttachment: async (i) => {
				sent.push(i.replyToMessageId);
				return ok({ messageId: "m2" });
			},
		};

		const text = await comm.sendText({ channelId: "c", text: intent.text });
		const voice = await speech.synthesize({
			text: intent.text,
			values: {
				engine: "aivoice",
				preset: "結月 ゆかり",
				presetOverrides: { Styles: [{ Name: "J", Value: 0.4 }] },
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
		});
		if (!text.ok || !voice.ok) throw new Error("unreachable");
		const att = await comm.sendAttachment({
			channelId: "c",
			replyToMessageId: text.value.messageId,
			filename: "voice.wav",
			contentType: voice.value.contentType,
			data: voice.value.audio,
		});

		expect(sent).toEqual(["m1"]);
		expect(att).toEqual(ok({ messageId: "m2" }));
	});
});

describe("deriveBodyState", () => {
	const now = new Date("2026-01-01T00:10:00Z");
	const report = (
		availability: OrganAvailability["availability"],
		checkedAt = "2026-01-01T00:09:00Z",
		organId = "ochoko",
	): OrganAvailability => ({ organId, availability, checkedAt });
	const derive = (reports: OrganAvailability[]) =>
		deriveBodyState({
			speechOrganId: "ochoko",
			reports,
			now,
			maxAgeMs: 120_000,
		});

	it("可用性を身体の状態に対応づける", () => {
		expect(derive([report("ready")])).toBe("can_speak");
		expect(derive([report("asleep")])).toBe("asleep");
		expect(derive([report("waking")])).toBe("waking");
		expect(derive([report("unavailable")])).toBe("unavailable");
		expect(derive([report("unreachable")])).toBe("unavailable");
	});

	it("報告がなければ unavailable", () => {
		expect(derive([])).toBe("unavailable");
		expect(derive([report("ready", undefined, "other")])).toBe("unavailable");
	});

	it("最新の報告を採る", () => {
		expect(
			derive([
				report("asleep", "2026-01-01T00:08:30Z"),
				report("ready", "2026-01-01T00:09:30Z"),
			]),
		).toBe("can_speak");
	});

	it("鮮度の境界: ちょうど maxAgeMs は有効、超えると unavailable", () => {
		expect(derive([report("ready", "2026-01-01T00:08:00Z")])).toBe("can_speak");
		expect(derive([report("ready", "2026-01-01T00:07:59Z")])).toBe(
			"unavailable",
		);
	});

	it("checkedAt が不正な報告は無視する", () => {
		expect(derive([report("ready", "not-a-date")])).toBe("unavailable");
	});
});
