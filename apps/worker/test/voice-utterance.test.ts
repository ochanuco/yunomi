import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
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
import type { GatewayResponse } from "@yunomi/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoiceOrgans } from "../src/voice-organs.ts";
import { installFakeLlm, llmOk, newScenario, T0, turn } from "./e2e/harness.ts";
import { PARTNER_ID, partnerStub } from "./helpers.ts";

const fakePort = () => {
	let n = 0;
	return {
		sendText: vi.fn(
			async (_i: {
				channelId: string;
				text: string;
				replyToMessageId?: string;
				nonce?: string;
			}): Promise<Result<SentMessage, DomainError>> =>
				ok({ messageId: `d-${++n}` }),
		),
		sendTyping: vi.fn(async () => ok(undefined)),
		sendAttachment: vi.fn(async (_i: unknown) => ok({ messageId: "d-600" })),
	};
};

const readyOrgans = (): VoiceOrgans => ({
	speech: {
		synthesize: async (): Promise<Result<SpeechResult, DomainError>> =>
			ok({
				audio: new Uint8Array([1]),
				contentType: "audio/wav",
				durationMs: 100,
			}),
	},
	checkAvailability: async (at) => ({
		organId: "ochoko",
		availability: "ready",
		checkedAt: at.toISOString(),
	}),
	wake: async () => ok(undefined),
});

const install = (port: CommunicationPort | null, organs: VoiceOrgans | null) =>
	runInDurableObject(partnerStub(PARTNER_ID), (o) => {
		o.createCommunication = () => port;
		o.createVoiceOrgans = () => organs;
		o.now = () => T0;
	});

const post = (path: string, body: unknown) =>
	exports.default.fetch(
		new Request(`http://localhost${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-yunomi-dev-caller": "gateway",
			},
			body: JSON.stringify(body),
		}),
	);

const report = (channelId: string | null, listening?: boolean) =>
	post("/v1/partners/yukarin/discord/voice-connection", {
		guild_id: "g1",
		channel_id: channelId,
		...(listening === undefined ? {} : { listening }),
	});

const utterance = (
	s: ReturnType<typeof newScenario>,
	text = "ただいま",
	eventId: string = crypto.randomUUID(),
) => ({
	event_id: eventId,
	type: "discord.voice.utterance",
	source: "discord",
	partner_id: PARTNER_ID,
	occurred_at: T0.toISOString(),
	received_at: T0.toISOString(),
	schema_version: 1,
	payload: {
		guild_id: "g1",
		channel_id: s.channelId,
		author: { id: s.author.id, display_name: s.author.displayName },
		text,
		duration_ms: 1200,
	},
});

const hear = async (body: unknown): Promise<GatewayResponse> => {
	const res = await post("/v1/interfaces/discord/events", body);
	expect(res.status).toBe(200);
	await partnerStub(PARTNER_ID).flushBackground();
	return res.json<GatewayResponse>();
};

afterEach(async () => {
	await install(null, null);
	await report(null);
});

describe("VC で聞いた発話のターン", () => {
	it("聞き取った文字をチャットに書いてからターンを回し、声の指示を返す", async () => {
		const s = newScenario();
		await report(s.channelId, true);
		const fake = await installFakeLlm([
			llmOk(turn({ messages: ["おかえり"] })),
		]);
		const port = fakePort();
		await install(port, readyOrgans());

		const res = await hear(utterance(s, "ただいま"));

		expect(port.sendText.mock.calls.map(([c]) => c.text)).toEqual([
			`${s.author.displayName}: ただいま`,
			"おかえり",
		]);
		expect(port.sendText.mock.calls[0]?.[0].channelId).toBe(s.channelId);
		// 名前もメンションも無い最初の一言でも、割り込みの判定を通さずに返事のターンに進む
		expect(fake.requests).toHaveLength(1);
		expect(res).toMatchObject({
			action: "ack",
			voice: { speak: { channel_id: s.channelId, text: "おかえり" } },
		});
	});

	it("同じ event_id の再送ではターンも書き込みも 1 回だけ", async () => {
		const s = newScenario();
		await report(s.channelId, true);
		const fake = await installFakeLlm([llmOk(turn()), llmOk(turn())]);
		const port = fakePort();
		await install(port, readyOrgans());
		const body = utterance(s);

		const first = await hear(body);
		const again = await hear(body);

		expect(again).toEqual(first);
		expect(fake.requests).toHaveLength(1);
		expect(port.sendText).toHaveBeenCalledTimes(2);
	});

	it("返事を返信形式にしない", async () => {
		const s = newScenario();
		await report(s.channelId, true);
		await installFakeLlm([llmOk(turn({ messages: ["うん", "それで？"] }))]);
		const port = fakePort();
		await install(port, readyOrgans());

		await hear(utterance(s));

		expect(port.sendText).toHaveBeenCalledTimes(3);
		for (const [c] of port.sendText.mock.calls) {
			expect(c.replyToMessageId).toBeUndefined();
		}
	});

	it("送信を Gateway に任せるときも、reply に返信先を載せない", async () => {
		const s = newScenario();
		await report(s.channelId, true);
		await installFakeLlm([llmOk(turn())]);
		await install(null, null);

		const res = await hear(utterance(s));

		expect(res.action).toBe("reply");
		expect(res).not.toHaveProperty("reply_to_message_id");
	});

	it("黙るときは、聞き取った文字だけを書いて何も返さない", async () => {
		const s = newScenario();
		await report(s.channelId, true);
		await installFakeLlm([
			llmOk(turn({ reply_policy: "ignore", messages: [] })),
		]);
		const port = fakePort();
		await install(port, readyOrgans());

		expect(await hear(utterance(s, "うーん"))).toEqual({ action: "ignore" });
		expect(port.sendText).toHaveBeenCalledTimes(1);
	});

	it("聞き取った文字だと分かる形でプロンプトに載せ、耳の状態で行を変える", async () => {
		const system = async (listening: boolean | undefined) => {
			const s = newScenario();
			await report(s.channelId, listening);
			const fake = await installFakeLlm([llmOk(turn())]);
			await install(fakePort(), readyOrgans());
			await hear(utterance(s));
			const req = fake.requests[0];
			expect(JSON.stringify(req?.messages)).toContain("聞き取った結果");
			return JSON.stringify(req?.system);
		};

		expect(await system(true)).toContain("相手の声が聞こえる");
		expect(await system(false)).toContain("聞くことはできない");
		expect(await system(undefined)).toContain("聞くことはできない");
	});

	it.each([
		[
			"エラーを返す",
			async () => err(externalServiceUnavailable({ service: "discord" })),
		],
		[
			"例外を投げる",
			async () => {
				throw new Error("boom");
			},
		],
	])(
		"聞き取った文字の書き込みが%sときも、ターンを回して返事を出す",
		async (_, fail) => {
			const s = newScenario();
			await report(s.channelId, true);
			const fake = await installFakeLlm([
				llmOk(turn({ messages: ["おかえり"] })),
			]);
			const port = fakePort();
			port.sendText.mockImplementationOnce(fail);
			await install(port, readyOrgans());

			const res = await hear(utterance(s));

			expect(fake.requests).toHaveLength(1);
			expect(port.sendText.mock.calls.map(([c]) => c.text)).toEqual([
				`${s.author.displayName}: ただいま`,
				"おかえり",
			]);
			expect(res).toMatchObject({ action: "ack" });
		},
	);

	it("同じ発話が同時に 2 つ届いてもターンは 1 回", async () => {
		const s = newScenario();
		await report(s.channelId, true);
		const fake = await installFakeLlm([llmOk(turn()), llmOk(turn())]);
		const port = fakePort();
		await install(port, readyOrgans());
		const body = utterance(s);

		const [first, again] = await Promise.all([hear(body), hear(body)]);

		expect(again).toEqual(first);
		expect(fake.requests).toHaveLength(1);
		expect(port.sendText).toHaveBeenCalledTimes(2);
	});

	it("書き込みの nonce は返事の nonce と重ならない", async () => {
		const s = newScenario();
		await report(s.channelId, true);
		await installFakeLlm([llmOk(turn({ messages: ["うん", "それで？"] }))]);
		const port = fakePort();
		await install(port, readyOrgans());

		await hear(utterance(s));

		const nonces = port.sendText.mock.calls.map(([c]) => c.nonce);
		expect(nonces).toHaveLength(3);
		expect(nonces.every((n) => n !== undefined)).toBe(true);
		expect(new Set(nonces).size).toBe(3);
	});

	it("複数メッセージの返事の途中に、次の発話の書き込みを割り込ませない", async () => {
		const s = newScenario();
		await report(s.channelId, true);
		await installFakeLlm([
			llmOk(turn({ messages: ["うん", "それで？"] })),
			llmOk(turn({ messages: ["へえ"] })),
		]);
		const port = fakePort();
		await install(port, readyOrgans());
		// 1 件目と 2 件目の間の待ちを止め、その間に次の発話を届ける
		let release = () => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		await runInDurableObject(partnerStub(PARTNER_ID), (o) => {
			o.sleep = () => held;
		});

		const first = hear(utterance(s, "ただいま"));
		await vi.waitFor(() => expect(port.sendText).toHaveBeenCalledTimes(2));
		const second = hear(utterance(s, "あのね"));
		await new Promise((r) => setTimeout(r, 50));
		release();
		await Promise.all([first, second]);

		expect(port.sendText.mock.calls.map(([c]) => c.text)).toEqual([
			`${s.author.displayName}: ただいま`,
			"うん",
			"それで？",
			`${s.author.displayName}: あのね`,
			"へえ",
		]);
	});

	it("聞いた発話は、後のターンの履歴でも声で話したと分かる", async () => {
		const s = newScenario();
		await report(s.channelId, true);
		const fake = await installFakeLlm([
			llmOk(turn({ messages: ["おかえり"] })),
			llmOk(turn({ messages: ["うん"] })),
		]);
		await install(fakePort(), readyOrgans());

		await hear(utterance(s, "ただいま"));
		await hear(utterance(s, "あのね"));

		const log = JSON.stringify(fake.requests[1]?.messages);
		expect(log).toContain(
			`${s.author.displayName}（VC で声で話した。文字は聞き取った結果で、聞き違いがありうる）: ただいま`,
		);
	});

	it("聞き取った文字はコードポイント単位で 2000 文字に切る", async () => {
		const s = newScenario();
		await report(s.channelId, true);
		await installFakeLlm([llmOk(turn())]);
		const port = fakePort();
		await install(port, readyOrgans());

		await hear(utterance(s, "🍵".repeat(2000)));

		const line = port.sendText.mock.calls[0]?.[0].text ?? "";
		const chars = Array.from(line);
		expect(chars).toHaveLength(2000);
		expect(chars.at(-1)).toBe("🍵");
	});

	it("不正な発話は 400", async () => {
		const s = newScenario();
		const body = utterance(s, "   ");
		const res = await post("/v1/interfaces/discord/events", body);
		expect(res.status).toBe(400);
	});
});

describe("voice-connection の耳の報告", () => {
	it("listening を接続と一緒に覚え、省略や切断では false にする", async () => {
		const read = () =>
			runInDurableObject(partnerStub(PARTNER_ID), (o) => o.voiceConnection());

		await report("vc1", true);
		expect(await read()).toMatchObject({ channelId: "vc1", listening: true });
		await report("vc1");
		expect(await read()).toMatchObject({ channelId: "vc1", listening: false });
		await report(null, true);
		expect(await read()).toMatchObject({ channelId: null, listening: false });
	});
});
