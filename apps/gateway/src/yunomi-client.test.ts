import { newId } from "@yunomi/core";
import type { DiscordMessageCreatedEnvelope } from "@yunomi/protocol";
import { describe, expect, it, vi } from "vitest";
import { EVENTS_PATH, YunomiClient } from "./yunomi-client.ts";

const envelope: DiscordMessageCreatedEnvelope = {
	event_id: newId(),
	type: "discord.message.created",
	source: "discord",
	partner_id: "yukarin",
	occurred_at: "2026-01-01T00:00:00.000Z",
	received_at: "2026-01-01T00:00:01.000Z",
	schema_version: 1,
	payload: {
		guild_id: "1",
		channel_id: "2",
		message_id: "3",
		author: { id: "4", display_name: "alice", is_bot: false },
		content: "hi",
		mentions: [],
		attachments: [],
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

describe("YunomiClient.send", () => {
	it("reply を返し、URL・body・Access ヘッダを正しく送る", async () => {
		const { client, fetchMock } = setup(
			[json({ action: "reply", content: "やあ", reply_to_message_id: "3" })],
			{ access: { clientId: "id", clientSecret: "secret" } },
		);
		const r = await client.send(envelope);
		expect(r).toEqual({
			ok: true,
			value: { action: "reply", content: "やあ", reply_to_message_id: "3" },
		});
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe(`https://yunomi.example${EVENTS_PATH}`);
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toEqual(envelope);
		const h = init?.headers as Record<string, string>;
		expect(h["CF-Access-Client-Id"]).toBe("id");
		expect(h["CF-Access-Client-Secret"]).toBe("secret");
		expect(h["x-yunomi-dev-caller"]).toBeUndefined();
	});

	it("Access 未設定で devCaller なら x-yunomi-dev-caller を送る", async () => {
		const { client, fetchMock } = setup([json({ action: "ignore" })], {
			devCaller: true,
		});
		await client.send(envelope);
		const h = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
		expect(h["x-yunomi-dev-caller"]).toBe("gateway");
		expect(h["CF-Access-Client-Id"]).toBeUndefined();
	});

	it("ignore を返す", async () => {
		const { client } = setup([json({ action: "ignore" })]);
		expect(await client.send(envelope)).toEqual({
			ok: true,
			value: { action: "ignore" },
		});
	});

	it("ack を返す", async () => {
		const { client } = setup([json({ action: "ack" })]);
		expect(await client.send(envelope)).toEqual({
			ok: true,
			value: { action: "ack" },
		});
	});

	it("503 のあと成功すれば再送して 1 秒待つ", async () => {
		const { client, fetchMock, sleep } = setup([
			new Response("x", { status: 503 }),
			json({ action: "ignore" }),
		]);
		const r = await client.send(envelope);
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
		const r = await client.send(envelope);
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
	});

	it("401 は再送しない", async () => {
		const { client, fetchMock, sleep } = setup([
			new Response("no", { status: 401 }),
		]);
		const r = await client.send(envelope);
		expect(!r.ok && r.error.type).toBe("PermissionDenied");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("400 は再送しない", async () => {
		const { client, fetchMock } = setup([new Response("bad", { status: 400 })]);
		const r = await client.send(envelope);
		expect(!r.ok && r.error.type).toBe("ValidationFailed");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("429 は retry-after に従って待つ", async () => {
		const { client, sleep } = setup([
			new Response("slow", { status: 429, headers: { "retry-after": "7" } }),
			json({ action: "ignore" }),
		]);
		const r = await client.send(envelope);
		expect(r.ok).toBe(true);
		expect(sleep).toHaveBeenCalledWith(7000);
	});

	it("契約違反のレスポンスは ValidationFailed で再送しない", async () => {
		const { client, fetchMock } = setup([json({ action: "dm" })]);
		const r = await client.send(envelope);
		expect(!r.ok && r.error.type).toBe("ValidationFailed");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("YunomiClient.notifySent", () => {
	const sent = {
		partner_message_id: "partner:x",
		channel_id: "2",
		discord_message_id: "500",
	};

	it("partner 別の sent パスへ body と認証ヘッダを送る", async () => {
		const { client, fetchMock } = setup([json({ bound: true })], {
			devCaller: true,
		});
		const r = await client.notifySent("yukarin", sent);
		expect(r.ok && r.value).toEqual({ bound: true });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://yunomi.example/v1/partners/yukarin/discord/sent");
		expect(JSON.parse(String(init?.body))).toEqual(sent);
		const h = init?.headers as Record<string, string>;
		expect(h["x-yunomi-dev-caller"]).toBe("gateway");
	});

	it("503 は再送し、403 は再送しない", async () => {
		const retried = setup([
			new Response("x", { status: 503 }),
			json({ bound: true }),
		]);
		expect((await retried.client.notifySent("yukarin", sent)).ok).toBe(true);
		expect(retried.fetchMock).toHaveBeenCalledTimes(2);

		const denied = setup([new Response("no", { status: 403 })]);
		const r = await denied.client.notifySent("yukarin", sent);
		expect(!r.ok && r.error.type).toBe("PermissionDenied");
		expect(denied.fetchMock).toHaveBeenCalledTimes(1);
	});
});
