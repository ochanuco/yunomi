import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
	type CommunicationPort,
	type DomainError,
	err,
	initialPartnerState,
	ok,
	type Presence,
	type Result,
	rateLimited,
	type SentMessage,
	type SpeechResult,
} from "@yunomi/core";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import type { VoiceDirective, VoiceResponse } from "@yunomi/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DoStore } from "../src/do/store.ts";
import type { VoiceOrgans } from "../src/voice-organs.ts";
import {
	installFakeLlm,
	llmOk,
	mention,
	newScenario,
	send,
	T0,
	turn,
} from "./e2e/harness.ts";
import { PARTNER_ID, partnerStub } from "./helpers.ts";

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
				audio: new Uint8Array([1]),
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

const report = (channelId: string | null) =>
	post("/v1/partners/yukarin/discord/voice-connection", {
		guild_id: "g1",
		channel_id: channelId,
	});

const voiceEvent = (
	payload: Partial<{
		user: { id: string; display_name: string; is_bot: boolean };
		from_channel_id: string | null;
		to_channel_id: string | null;
		humans_in_from: number;
		humans_in_to: number;
		partner_channel_id: string | null;
		humans_in_partner_channel: number;
	}> = {},
) => ({
	event_id: crypto.randomUUID(),
	type: "discord.voice_state.updated",
	source: "discord",
	partner_id: PARTNER_ID,
	occurred_at: T0.toISOString(),
	received_at: T0.toISOString(),
	schema_version: 1,
	payload: {
		guild_id: "g1",
		user: { id: "vu1", display_name: "alice", is_bot: false },
		from_channel_id: null,
		to_channel_id: "vc1",
		humans_in_from: 0,
		humans_in_to: 1,
		partner_channel_id: null,
		humans_in_partner_channel: 0,
		...payload,
	},
});

const decide = async (
	payload: Parameters<typeof voiceEvent>[0] = {},
): Promise<VoiceResponse> => {
	const res = await post(
		"/v1/interfaces/discord/voice-events",
		voiceEvent(payload),
	);
	expect(res.status).toBe(200);
	const body = await res.json<VoiceResponse>();
	await partnerStub(PARTNER_ID).flushBackground();
	return body;
};

const seedFriend = (userId: string, level = 0.5) =>
	runInDurableObject(partnerStub(PARTNER_ID), (_o, st) => {
		const store = new DoStore(st.storage.sql);
		store.cacheEntity("discord", userId, `ent-${userId}`);
		store.putRelationship(
			{
				partnerId: PARTNER_ID,
				entityId: `ent-${userId}`,
				familiarity: level,
				trust: level,
				summary: null,
				version: 1,
				updatedAt: T0.toISOString(),
			},
			{ day: "2026-10-11", familiarity: 0, trust: 0 },
		);
	});

const setPresence = (presence: Presence) =>
	runInDurableObject(partnerStub(PARTNER_ID), (_o, st) => {
		new DoStore(st.storage.sql).putState({
			...initialPartnerState(yukarinProfile, T0),
			presence,
		});
	});

afterEach(async () => {
	await install(null, null);
	await report(null);
	await runInDurableObject(partnerStub(PARTNER_ID), async (_o, st) => {
		await st.storage.delete("voice:organ");
	});
	await setPresence("available");
});

describe("VC の出入りの判断", () => {
	it("親しい人が VC に入ったらついて行く", async () => {
		await seedFriend("vu1");
		const o = fakeOrgans({ availability: "ready" });
		await install(fakePort(), o.organs);

		expect(await decide()).toEqual({
			action: "voice_join",
			guild_id: "g1",
			channel_id: "vc1",
		});
		expect(o.wake).not.toHaveBeenCalled();
	});

	it("away でもついて行く", async () => {
		await seedFriend("vu1");
		await setPresence("away");
		await install(fakePort(), fakeOrgans({ availability: "ready" }).organs);
		expect((await decide()).action).toBe("voice_join");
	});

	it("GPU 機が寝ていればついて行きつつ起こす", async () => {
		await seedFriend("vu1");
		const o = fakeOrgans({ availability: "asleep" });
		await install(fakePort(), o.organs);

		expect((await decide()).action).toBe("voice_join");
		expect(o.wake).toHaveBeenCalledTimes(1);
	});

	it("知らない人にはついて行かず、entity も作らない", async () => {
		const o = fakeOrgans({ availability: "ready" });
		await install(fakePort(), o.organs);
		const before = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM entities",
		).first<{ n: number }>();

		expect(
			await decide({
				user: { id: "stranger", display_name: "x", is_bot: false },
			}),
		).toEqual({
			action: "ignore",
		});

		const after = await env.DB.prepare(
			"SELECT COUNT(*) AS n FROM entities",
		).first<{ n: number }>();
		expect(after?.n).toBe(before?.n);
		const identity = await env.DB.prepare(
			"SELECT 1 FROM external_identities WHERE external_id = 'stranger'",
		).first();
		expect(identity).toBeNull();
		expect(o.wake).not.toHaveBeenCalled();
	});

	it("初対面の段階ならついて行かない", async () => {
		await seedFriend("vu1", 0.1);
		await install(fakePort(), fakeOrgans({ availability: "ready" }).organs);
		expect(await decide()).toEqual({ action: "ignore" });
	});

	it.each(["sleeping", "busy", "do_not_disturb"] as const)(
		"%s ならついて行かない",
		async (presence) => {
			await seedFriend("vu1");
			await setPresence(presence);
			await install(fakePort(), fakeOrgans({ availability: "ready" }).organs);
			expect(await decide()).toEqual({ action: "ignore" });
		},
	);

	it("声が使えない身体ならついて行かない", async () => {
		await seedFriend("vu1");
		await install(fakePort(), null);
		expect(await decide()).toEqual({ action: "ignore" });
		await install(
			fakePort(),
			fakeOrgans({ availability: "unreachable" }).organs,
		);
		expect(await decide()).toEqual({ action: "ignore" });
	});

	it("bot と、VC から出た人にはついて行かない", async () => {
		await seedFriend("vu1");
		await install(fakePort(), fakeOrgans({ availability: "ready" }).organs);
		expect(
			await decide({
				user: { id: "vu1", display_name: "alice", is_bot: true },
			}),
		).toEqual({ action: "ignore" });
		expect(
			await decide({
				from_channel_id: "vc1",
				to_channel_id: null,
				humans_in_from: 1,
			}),
		).toEqual({ action: "ignore" });
	});

	it("すでに人のいる VC にいるならついて行かない", async () => {
		await seedFriend("vu1");
		await install(fakePort(), fakeOrgans({ availability: "ready" }).organs);
		expect(
			await decide({
				to_channel_id: "vc2",
				partner_channel_id: "vc1",
				humans_in_partner_channel: 1,
			}),
		).toEqual({ action: "ignore" });
	});

	it("いまの VC が無人になる移動では、新しい VC へ移る", async () => {
		await seedFriend("vu1");
		await install(fakePort(), fakeOrgans({ availability: "ready" }).organs);
		expect(
			await decide({
				from_channel_id: "vc1",
				to_channel_id: "vc2",
				partner_channel_id: "vc1",
				humans_in_partner_channel: 0,
			}),
		).toEqual({ action: "voice_join", guild_id: "g1", channel_id: "vc2" });
	});

	it("いる VC から人がいなくなったら出る", async () => {
		await install(fakePort(), fakeOrgans({ availability: "ready" }).organs);
		expect(
			await decide({
				from_channel_id: "vc1",
				to_channel_id: null,
				humans_in_from: 0,
				partner_channel_id: "vc1",
				humans_in_partner_channel: 0,
			}),
		).toEqual({ action: "voice_leave", guild_id: "g1" });
	});

	it("payload に接続先が無ければ DO の状態を使って出る", async () => {
		await report("vc1");
		expect(
			await decide({
				from_channel_id: "vc1",
				to_channel_id: null,
				partner_channel_id: null,
				humans_in_partner_channel: 0,
			}),
		).toEqual({ action: "voice_leave", guild_id: "g1" });
	});

	it("人が残っていれば出ない", async () => {
		expect(
			await decide({
				from_channel_id: "vc1",
				to_channel_id: null,
				partner_channel_id: "vc1",
				humans_in_partner_channel: 2,
			}),
		).toEqual({ action: "ignore" });
	});

	it("VC に入っていなければ出ない", async () => {
		expect(
			await decide({ from_channel_id: "vc9", to_channel_id: null }),
		).toEqual({ action: "ignore" });
	});
});

describe("voice-connection の報告", () => {
	it("接続先を記録し、null で消す", async () => {
		const read = () =>
			runInDurableObject(partnerStub(PARTNER_ID), (o) => o.voiceConnection());

		const res = await report("vc1");
		expect(res.status).toBe(200);
		expect(await read()).toMatchObject({ guildId: "g1", channelId: "vc1" });
		await report(null);
		expect(await read()).toMatchObject({ guildId: "g1", channelId: null });
	});

	it("不正な body は 400、未知の partner は 404", async () => {
		const bad = await post("/v1/partners/yukarin/discord/voice-connection", {
			guild_id: "g1",
		});
		expect(bad.status).toBe(400);
		const unknown = await post("/v1/partners/nobody/discord/voice-connection", {
			guild_id: "g1",
			channel_id: null,
		});
		expect(unknown.status).toBe(404);
	});
});

type Sent = { action: string; voice?: VoiceDirective };

const sendAs = async (msg: ReturnType<typeof mention>): Promise<Sent> =>
	(await send(msg)) as Sent;

describe("VC のテキストチャットへの返事", () => {
	it("ack に voice.speak を載せ、WAV は添付しない（speak_aloud が false でも）", async () => {
		const s = newScenario();
		await report(s.channelId);
		await installFakeLlm([
			llmOk(turn({ messages: ["おはよう"], speak_aloud: false })),
		]);
		const port = fakePort();
		const o = fakeOrgans({ availability: "ready" });
		await install(port, o.organs);

		const res = await sendAs(mention(s));

		expect(res.action).toBe("ack");
		expect(res.voice?.speak).toMatchObject([
			{
				channel_id: s.channelId,
				text: "おはよう",
				values: { engine: "aivoice", preset: "結月 ゆかり" },
			},
		]);
		expect(port.sendText).toHaveBeenCalledTimes(1);
		expect(o.synthesize).not.toHaveBeenCalled();
		expect(port.sendAttachment).not.toHaveBeenCalled();
	});

	it("複数件の返事は、送れたメッセージごとに speak を並べる", async () => {
		const s = newScenario();
		await report(s.channelId);
		await installFakeLlm([
			llmOk(turn({ messages: ["えっ", "本当に", "すごい"] })),
		]);
		const port = fakePort();
		port.sendText
			.mockImplementationOnce(async () => ok({ messageId: "d-1" }))
			.mockImplementationOnce(async () => ok({ messageId: "d-2" }))
			.mockImplementationOnce(async () =>
				err(rateLimited({ retryAfterMs: 9000 })),
			);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const o = fakeOrgans({ availability: "ready" });
		await install(port, o.organs);
		await runInDurableObject(partnerStub(PARTNER_ID), (d) => {
			d.sleep = async () => {};
		});

		const res = await sendAs(mention(s));

		expect(res.voice?.speak?.map((x) => x.text)).toEqual(["えっ", "本当に"]);
	});

	it("speak_aloud が true でも添付ではなく VC で再生する", async () => {
		const s = newScenario();
		await report(s.channelId);
		await installFakeLlm([llmOk(turn({ speak_aloud: true }))]);
		const port = fakePort();
		const o = fakeOrgans({ availability: "ready" });
		await install(port, o.organs);

		const res = await sendAs(mention(s));

		expect(res.voice?.speak).toBeDefined();
		expect(o.synthesize).not.toHaveBeenCalled();
		expect(port.sendAttachment).not.toHaveBeenCalled();
	});

	it("GPU 機が寝ていれば起こす", async () => {
		const s = newScenario();
		await report(s.channelId);
		await installFakeLlm([llmOk(turn())]);
		const o = fakeOrgans({ availability: "asleep" });
		await install(fakePort(), o.organs);

		const res = await sendAs(mention(s));

		expect(res.voice?.speak).toBeDefined();
		expect(o.wake).toHaveBeenCalledTimes(1);
	});

	it("声が使えなければテキストだけで返す", async () => {
		const s = newScenario();
		await report(s.channelId);
		await installFakeLlm([llmOk(turn({ speak_aloud: true }))]);
		const port = fakePort();
		await install(port, null);

		expect(await sendAs(mention(s))).toEqual({ action: "ack" });
		expect(port.sendText).toHaveBeenCalledTimes(1);
		expect(port.sendAttachment).not.toHaveBeenCalled();
	});

	it("VC 以外のチャンネルでは今までどおり WAV を添付する", async () => {
		const s = newScenario();
		await report("some-other-vc");
		await installFakeLlm([llmOk(turn({ speak_aloud: true }))]);
		const port = fakePort();
		const o = fakeOrgans({ availability: "ready" });
		await install(port, o.organs);

		expect(await sendAs(mention(s))).toEqual({ action: "ack" });
		expect(o.synthesize).toHaveBeenCalledTimes(1);
		expect(port.sendAttachment).toHaveBeenCalledTimes(1);
	});

	it("VC に入っていなければ speak を載せない", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(turn())]);
		await install(fakePort(), fakeOrgans({ availability: "ready" }).organs);
		expect(await sendAs(mention(s))).toEqual({ action: "ack" });
	});

	it("プロンプトに VC の状態を載せる", async () => {
		const s = newScenario();
		await report(s.channelId);
		const fake = await installFakeLlm([llmOk(turn())]);
		await install(fakePort(), fakeOrgans({ availability: "ready" }).organs);

		await sendAs(mention(s));

		expect(JSON.stringify(fake.requests[0]?.system)).toContain(
			"VC のテキストチャットから来た",
		);
	});
});

describe("voice_channel の出力", () => {
	it("join: 作者が VC にいれば ack に voice.join を載せ、GPU 機を起こす", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(turn({ voice_channel: "join" }))]);
		const o = fakeOrgans({ availability: "asleep" });
		await install(fakePort(), o.organs);

		const res = await sendAs(mention(s, { authorVoiceChannelId: "vc7" }));

		expect(res.action).toBe("ack");
		expect(res.voice).toEqual({ join: { guild_id: "g1", channel_id: "vc7" } });
		expect(o.wake).toHaveBeenCalledTimes(1);
	});

	it("join: 作者が VC にいなければ何もしない", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(turn({ voice_channel: "join" }))]);
		const o = fakeOrgans({ availability: "asleep" });
		await install(fakePort(), o.organs);

		expect(await sendAs(mention(s))).toEqual({ action: "ack" });
		expect(o.wake).not.toHaveBeenCalled();
	});

	it("join: すでに別の VC にいれば何もしない", async () => {
		const s = newScenario();
		await report("other");
		await installFakeLlm([llmOk(turn({ voice_channel: "join" }))]);
		await install(fakePort(), fakeOrgans({ availability: "ready" }).organs);

		expect(await sendAs(mention(s, { authorVoiceChannelId: "vc7" }))).toEqual({
			action: "ack",
		});
	});

	it("leave: VC にいれば voice.leave を載せる", async () => {
		const s = newScenario();
		await report("vc7");
		await installFakeLlm([llmOk(turn({ voice_channel: "leave" }))]);
		await install(fakePort(), fakeOrgans({ availability: "ready" }).organs);

		expect(await sendAs(mention(s))).toEqual({
			action: "ack",
			voice: { leave: { guild_id: "g1" } },
		});
	});

	it("leave: VC にいなければ何もしない", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(turn({ voice_channel: "leave" }))]);
		await install(fakePort(), fakeOrgans({ availability: "ready" }).organs);

		expect(await sendAs(mention(s))).toEqual({ action: "ack" });
	});

	it("意思疎通の口が無いときは reply に載せる", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(turn({ voice_channel: "join" }))]);
		await install(null, null);

		const res = await sendAs(mention(s, { authorVoiceChannelId: "vc7" }));

		expect(res.action).toBe("reply");
		expect(res.voice).toEqual({ join: { guild_id: "g1", channel_id: "vc7" } });
	});
});
