import { newId } from "@yunomi/core";
import type { DiscordVoiceUtteranceEnvelope } from "@yunomi/protocol";
import { describe, expect, it, vi } from "vitest";
import { EVENTS_PATH, YunomiClient } from "./yunomi-client.ts";

const utterance: DiscordVoiceUtteranceEnvelope = {
	event_id: newId(),
	type: "discord.voice.utterance",
	source: "discord",
	partner_id: "yukarin",
	occurred_at: "2026-01-01T00:00:00.000Z",
	received_at: "2026-01-01T00:00:01.000Z",
	schema_version: 1,
	payload: {
		guild_id: "1",
		channel_id: "2",
		author: { id: "4", display_name: "alice" },
		text: "こんにちは",
		duration_ms: 1200,
	},
};

const voiceEvent = {
	event_id: newId(),
	type: "discord.voice_state.updated" as const,
	source: "discord" as const,
	partner_id: "yukarin",
	occurred_at: "2026-01-01T00:00:00.000Z",
	received_at: "2026-01-01T00:00:00.000Z",
	schema_version: 1 as const,
	payload: {
		guild_id: "1",
		user: { id: "4", display_name: "alice", is_bot: false },
		from_channel_id: null,
		to_channel_id: "2",
		humans_in_from: 0,
		humans_in_to: 1,
		partner_channel_id: null,
		humans_in_partner_channel: 0,
	},
};

const json = (body: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});

const setup = (
	responses: (Response | Error)[],
	over: Partial<ConstructorParameters<typeof YunomiClient>[0]> = {},
) => {
	const queue = [...responses];
	const fetchMock = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) => {
			const next = queue.shift();
			if (!next) throw new Error("no more responses");
			if (next instanceof Error) throw next;
			return next;
		},
	);
	const sleep = vi.fn(async (_ms: number) => {});
	const client = new YunomiClient({
		baseUrl: "https://yunomi.example/",
		access: null,
		devCaller: false,
		fetch: fetchMock as unknown as typeof fetch,
		sleep,
		...over,
	});
	return { client, fetchMock, sleep };
};

describe("YunomiClient.sendUtterance", () => {
	it("ack を返し、URL・body・Access ヘッダを正しく送る", async () => {
		const { client, fetchMock } = setup(
			[json({ action: "ack", voice: { leave: { guild_id: "1" } } })],
			{ access: { clientId: "id", clientSecret: "secret" } },
		);
		const r = await client.sendUtterance(utterance);
		expect(r).toEqual({
			ok: true,
			value: { action: "ack", voice: { leave: { guild_id: "1" } } },
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe(`https://yunomi.example${EVENTS_PATH}`);
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual(utterance);
		const h = init?.headers as Record<string, string>;
		expect(h["CF-Access-Client-Id"]).toBe("id");
		expect(h["CF-Access-Client-Secret"]).toBe("secret");
		expect(h["x-yunomi-dev-caller"]).toBeUndefined();
	});

	it("Access 未設定で devCaller なら x-yunomi-dev-caller を送る", async () => {
		const { client, fetchMock } = setup([json({ action: "ignore" })], {
			devCaller: true,
		});
		await client.sendUtterance(utterance);
		const h = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
		expect(h["x-yunomi-dev-caller"]).toBe("gateway");
		expect(h["CF-Access-Client-Id"]).toBeUndefined();
	});

	it("503 のあと成功すれば再送して 1 秒待つ", async () => {
		const { client, fetchMock, sleep } = setup([
			new Response("x", { status: 503 }),
			json({ action: "ignore" }),
		]);
		const r = await client.sendUtterance(utterance);
		expect(r.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(1000);
	});

	it("ネットワークエラーは 1s / 2s で再送し、3 回で諦める", async () => {
		const { client, fetchMock, sleep } = setup([
			new Error("down"),
			new Error("down"),
			new Error("down"),
		]);
		const r = await client.sendUtterance(utterance);
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
	});

	it("401 は再送しない", async () => {
		const { client, fetchMock, sleep } = setup([
			new Response("no", { status: 401 }),
		]);
		const r = await client.sendUtterance(utterance);
		expect(!r.ok && r.error.type).toBe("PermissionDenied");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("400 は再送しない", async () => {
		const { client, fetchMock } = setup([new Response("bad", { status: 400 })]);
		const r = await client.sendUtterance(utterance);
		expect(!r.ok && r.error.type).toBe("ValidationFailed");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("429 は retry-after に従って待つ", async () => {
		const { client, sleep } = setup([
			new Response("slow", { status: 429, headers: { "retry-after": "7" } }),
			json({ action: "ignore" }),
		]);
		const r = await client.sendUtterance(utterance);
		expect(r.ok).toBe(true);
		expect(sleep).toHaveBeenCalledWith(7000);
	});

	it("契約違反のレスポンスは ValidationFailed で再送しない", async () => {
		const { client, fetchMock } = setup([json({ action: "dm" })]);
		const r = await client.sendUtterance(utterance);
		expect(!r.ok && r.error.type).toBe("ValidationFailed");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("YunomiClient.sendVoiceEvent", () => {
	it("voice-events に送り、voice_join を返す", async () => {
		const { client, fetchMock } = setup([
			json({ action: "voice_join", guild_id: "1", channel_id: "2" }),
		]);
		const r = await client.sendVoiceEvent(voiceEvent);
		expect(r.ok && r.value).toEqual({
			action: "voice_join",
			guild_id: "1",
			channel_id: "2",
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe(
			"https://yunomi.example/v1/interfaces/discord/voice-events",
		);
		expect(JSON.parse(String(init?.body))).toEqual(voiceEvent);
	});

	it("契約違反のレスポンスは ValidationFailed", async () => {
		const { client } = setup([json({ action: "reply", content: "x" })]);
		const r = await client.sendVoiceEvent(voiceEvent);
		expect(!r.ok && r.error.type).toBe("ValidationFailed");
	});
});

describe("YunomiClient.reportVoiceConnection", () => {
	it("partner 別の voice-connection パスへ接続先を送る", async () => {
		const { client, fetchMock } = setup([json({})], { devCaller: true });
		const connection = { guild_id: "1", channel_id: "2", listening: true };
		const r = await client.reportVoiceConnection("yukarin", connection);
		expect(r.ok).toBe(true);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe(
			"https://yunomi.example/v1/partners/yukarin/discord/voice-connection",
		);
		expect(JSON.parse(String(init?.body))).toEqual(connection);
		const h = init?.headers as Record<string, string>;
		expect(h["x-yunomi-dev-caller"]).toBe("gateway");
	});

	it("503 は再送し、403 は再送しない", async () => {
		const connection = { guild_id: "1", channel_id: null, listening: false };
		const retried = setup([new Response("x", { status: 503 }), json({})]);
		expect(
			(await retried.client.reportVoiceConnection("yukarin", connection)).ok,
		).toBe(true);
		expect(retried.fetchMock).toHaveBeenCalledTimes(2);

		const denied = setup([new Response("no", { status: 403 })]);
		const r = await denied.client.reportVoiceConnection("yukarin", connection);
		expect(!r.ok && r.error.type).toBe("PermissionDenied");
		expect(denied.fetchMock).toHaveBeenCalledTimes(1);
	});
});
