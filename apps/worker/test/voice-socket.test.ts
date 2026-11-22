import { runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import {
	type CommunicationPort,
	type DomainError,
	ok,
	type Result,
	type SentMessage,
	type SpeechResult,
} from "@yunomi/core";
import type { GatewayResponse, VoiceSocketMessage } from "@yunomi/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VOICE_SOCKET_TAG } from "../src/do/partner-do.ts";
import type { VoiceOrgans } from "../src/voice-organs.ts";
import {
	installFakeLlm,
	llmOk,
	mention,
	newScenario,
	T0,
	turn,
} from "./e2e/harness.ts";
import { envelopeBody, PARTNER_ID, partnerStub } from "./helpers.ts";

type Caller = "gateway" | "voice" | "ykm";

const fakePort = () => ({
	sendText: vi.fn(
		async (): Promise<Result<SentMessage, DomainError>> =>
			ok({ messageId: "d-500" }),
	),
	sendTyping: vi.fn(async () => ok(undefined)),
	sendAttachment: vi.fn(async (_i: unknown) => ok({ messageId: "d-600" })),
});

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
});

const install = (port: CommunicationPort | null, organs: VoiceOrgans | null) =>
	runInDurableObject(partnerStub(PARTNER_ID), (o) => {
		o.createCommunication = () => port;
		o.createVoiceOrgans = () => organs;
		o.now = () => T0;
	});

const post = (path: string, body: unknown, caller: Caller = "gateway") =>
	exports.default.fetch(
		new Request(`http://localhost${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-yunomi-dev-caller": caller,
			},
			body: JSON.stringify(body),
		}),
	);

const report = (channelId: string | null, caller: Caller = "voice") =>
	post(
		"/v1/partners/yukarin/discord/voice-connection",
		{ guild_id: "g1", channel_id: channelId },
		caller,
	);

const voiceEvent = () => ({
	event_id: crypto.randomUUID(),
	type: "discord.voice_state.updated",
	source: "discord",
	partner_id: PARTNER_ID,
	occurred_at: T0.toISOString(),
	received_at: T0.toISOString(),
	schema_version: 1,
	payload: {
		guild_id: "g1",
		user: { id: "vs-u1", display_name: "alice", is_bot: false },
		from_channel_id: null,
		to_channel_id: "vc1",
		humans_in_from: 0,
		humans_in_to: 1,
		partner_channel_id: null,
		humans_in_partner_channel: 0,
	},
});

const utterance = (s: ReturnType<typeof newScenario>) => ({
	event_id: crypto.randomUUID(),
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
		text: "ただいま",
		duration_ms: 1200,
	},
});

const EVENTS = "/v1/interfaces/discord/events";

const turnOf = async (
	path: string,
	body: unknown,
	caller: Caller = "gateway",
): Promise<GatewayResponse> => {
	const res = await post(path, body, caller);
	expect(res.status).toBe(200);
	await partnerStub(PARTNER_ID).flushBackground();
	return res.json<GatewayResponse>();
};

const socketRequest = (
	opts: {
		caller?: Caller;
		method?: string;
		upgrade?: boolean;
		partner?: string;
	} = {},
) =>
	exports.default.fetch(
		new Request(
			`http://localhost/v1/partners/${opts.partner ?? PARTNER_ID}/voice/socket`,
			{
				method: opts.method ?? "GET",
				headers: {
					"x-yunomi-dev-caller": opts.caller ?? "voice",
					...(opts.upgrade === false ? {} : { Upgrade: "websocket" }),
				},
			},
		),
	);

const openSocket = async () => {
	const res = await socketRequest();
	expect(res.status).toBe(101);
	const ws = res.webSocket;
	if (!ws) throw new Error("no webSocket");
	ws.accept();
	const received: string[] = [];
	const waiters: (() => void)[] = [];
	ws.addEventListener("message", (e) => {
		received.push(String(e.data));
		for (const w of waiters.splice(0)) w();
	});
	const closed = new Promise<void>((resolve) =>
		ws.addEventListener("close", () => resolve()),
	);
	const next = async (): Promise<string> => {
		if (received.length === 0) {
			await new Promise<void>((resolve) => waiters.push(resolve));
		}
		return received.shift() as string;
	};
	return { ws, received, next, closed };
};

// 開いた socket が残ると、ほかのテストの応答から声の指示が消える。
afterEach(async () => {
	await runInDurableObject(partnerStub(PARTNER_ID), (o, st) => {
		for (const ws of st.getWebSockets(VOICE_SOCKET_TAG)) ws.close(1000, "test");
		o.voiceSockets = () => st.getWebSockets(VOICE_SOCKET_TAG);
	});
	await install(null, null);
	await report(null);
});

describe("呼び出し元 voice", () => {
	it("VC の口（voice-connection、voice-events、発話）は voice から受ける", async () => {
		expect((await report("vc1")).status).toBe(200);
		expect(
			(await post("/v1/interfaces/discord/voice-events", voiceEvent(), "voice"))
				.status,
		).toBe(200);

		const s = newScenario();
		await report(s.channelId);
		await installFakeLlm([llmOk(turn({ messages: ["おかえり"] }))]);
		await install(fakePort(), readyOrgans());
		expect(await turnOf(EVENTS, utterance(s), "voice")).toMatchObject({
			action: "ack",
		});
	});

	it("VC の口は gateway から受けない", async () => {
		expect((await report("vc1", "gateway")).status).toBe(403);
		expect(
			(
				await post(
					"/v1/interfaces/discord/voice-events",
					voiceEvent(),
					"gateway",
				)
			).status,
		).toBe(403);
		const s = newScenario();
		expect((await post(EVENTS, utterance(s), "gateway")).status).toBe(403);
	});

	it("テキストの口（発言、sent）は voice から受けない", async () => {
		const s = newScenario();
		const text = await post(EVENTS, envelopeBody(mention(s)), "voice");
		expect(text.status).toBe(403);
		const unknownType = await post(
			EVENTS,
			{ ...envelopeBody(mention(s)), type: "discord.unknown" },
			"voice",
		);
		expect(unknownType.status).toBe(403);
		const sent = await post(
			"/v1/partners/yukarin/discord/sent",
			{ partner_message_id: "p1", channel_id: "c1", discord_message_id: "d1" },
			"voice",
		);
		expect(sent.status).toBe(403);
	});

	it("ほかの service caller は VC の口に入れない", async () => {
		expect((await report("vc1", "ykm")).status).toBe(403);
	});
});

describe("voice の WebSocket の口", () => {
	it("voice 以外、GET 以外、Upgrade なし、未知の partner を拒む", async () => {
		expect((await socketRequest({ caller: "gateway" })).status).toBe(403);
		expect((await socketRequest({ caller: "ykm" })).status).toBe(403);
		expect(
			(await socketRequest({ method: "POST", upgrade: false })).status,
		).toBe(405);
		expect((await socketRequest({ upgrade: false })).status).toBe(426);
		expect((await socketRequest({ partner: "nobody" })).status).toBe(404);
	});

	it("ping には DO を起こさず pong を返す", async () => {
		const socket = await openSocket();
		socket.ws.send("ping");
		expect(await socket.next()).toBe("pong");
		const stamps = await runInDurableObject(partnerStub(PARTNER_ID), (_o, st) =>
			st
				.getWebSockets(VOICE_SOCKET_TAG)
				.filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN)
				.map((ws) => st.getWebSocketAutoResponseTimestamp(ws)),
		);
		expect(stamps).toHaveLength(1);
		expect(stamps[0]).toBeInstanceOf(Date);
	});

	it("つなぎ直すと古い接続を閉じる", async () => {
		const first = await openSocket();
		await openSocket();
		await first.closed;
		const open = await runInDurableObject(
			partnerStub(PARTNER_ID),
			(_o, st) =>
				st
					.getWebSockets(VOICE_SOCKET_TAG)
					.filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN).length,
		);
		expect(open).toBe(1);
	});
});

describe("テキストの発言のターンの声の指示", () => {
	const setup = async () => {
		const s = newScenario();
		await report(s.channelId);
		await installFakeLlm([llmOk(turn({ messages: ["おはよう"] }))]);
		await install(fakePort(), readyOrgans());
		return s;
	};

	it("WebSocket がつながっていればそこへ送り、relay への応答には載せない", async () => {
		const s = await setup();
		const socket = await openSocket();

		const res = await turnOf(EVENTS, envelopeBody(mention(s)));

		expect(res).toEqual({ action: "ack" });
		const message = JSON.parse(await socket.next()) as VoiceSocketMessage;
		expect(message).toMatchObject({
			type: "voice.directive",
			partner_id: PARTNER_ID,
			guild_id: "g1",
			channel_id: s.channelId,
			voice: { speak: { channel_id: s.channelId, text: "おはよう" } },
		});
	});

	it("つながっていなければ応答に載せる", async () => {
		const s = await setup();
		const res = await turnOf(EVENTS, envelopeBody(mention(s)));
		expect(res).toMatchObject({
			action: "ack",
			voice: { speak: { text: "おはよう" } },
		});
	});

	it("切れたあとは応答に戻る", async () => {
		const s = await setup();
		const socket = await openSocket();
		socket.ws.close(1000, "bye");
		await socket.closed;

		const res = await turnOf(EVENTS, envelopeBody(mention(s)));
		expect(res).toMatchObject({ voice: { speak: { text: "おはよう" } } });
	});

	it("送れなければ応答に載せる", async () => {
		const s = await setup();
		vi.spyOn(console, "error").mockImplementation(() => {});
		await runInDurableObject(partnerStub(PARTNER_ID), (o) => {
			const broken = {
				readyState: WebSocket.READY_STATE_OPEN,
				send: () => {
					throw new Error("closed");
				},
			} as unknown as WebSocket;
			o.voiceSockets = () => [broken];
		});

		const res = await turnOf(EVENTS, envelopeBody(mention(s)));
		expect(res).toMatchObject({ voice: { speak: { text: "おはよう" } } });
	});

	it("VC で聞いた発話のターンは WebSocket があっても応答で返す", async () => {
		const s = await setup();
		const socket = await openSocket();

		const res = await turnOf(EVENTS, utterance(s), "voice");

		expect(res).toMatchObject({ voice: { speak: { text: "おはよう" } } });
		expect(socket.received).toEqual([]);
	});
});
