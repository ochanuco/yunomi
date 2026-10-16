import { describe, expect, it, vi } from "vitest";
import { createDiscordRest } from "../src/discord-rest.ts";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

const setup = (responses: (Response | Error)[]) => {
	const queue = [...responses];
	const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
		const next = queue.shift();
		if (!next) throw new Error("no more responses");
		if (next instanceof Error) throw next;
		return next;
	});
	const sleep = vi.fn(async (_ms: number) => {});
	const port = createDiscordRest({
		token: "tok",
		fetch: fetchMock as unknown as typeof fetch,
		sleep,
	});
	return { port, fetchMock, sleep };
};

describe("sendText", () => {
	it("返信先つきで POST し、message id を返す", async () => {
		const { port, fetchMock } = setup([json({ id: "500" })]);
		const r = await port.sendText({
			channelId: "2",
			text: "やあ @everyone",
			replyToMessageId: "3",
		});
		expect(r).toEqual({ ok: true, value: { messageId: "500" } });
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://discord.com/api/v10/channels/2/messages");
		expect(init?.method).toBe("POST");
		const h = init?.headers as Record<string, string>;
		expect(h.authorization).toBe("Bot tok");
		expect(JSON.parse(String(init?.body))).toEqual({
			content: "やあ @everyone",
			allowed_mentions: { parse: [], replied_user: false },
			message_reference: { message_id: "3", fail_if_not_exists: false },
		});
	});

	it("返信先が無ければ message_reference を付けない", async () => {
		const { port, fetchMock } = setup([json({ id: "500" })]);
		await port.sendText({ channelId: "2", text: "やあ" });
		const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(body.message_reference).toBeUndefined();
	});

	it("429 は retry_after だけ待って再送する", async () => {
		const { port, fetchMock, sleep } = setup([
			json({ retry_after: 1.2 }, 429),
			json({ id: "500" }),
		]);
		const r = await port.sendText({ channelId: "2", text: "x" });
		expect(r.ok).toBe(true);
		expect(sleep).toHaveBeenCalledWith(1200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("待ちが長い 429 は再送せず RateLimited を返す", async () => {
		const { port, fetchMock, sleep } = setup([json({ retry_after: 30 }, 429)]);
		const r = await port.sendText({ channelId: "2", text: "x" });
		expect(!r.ok && r.error).toMatchObject({
			type: "RateLimited",
			retryAfterMs: 30000,
		});
		expect(sleep).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("429 が続けば上限で諦める", async () => {
		const { port, fetchMock } = setup([
			json({ retry_after: 0.1 }, 429),
			json({ retry_after: 0.1 }, 429),
			json({ retry_after: 0.1 }, 429),
		]);
		const r = await port.sendText({ channelId: "2", text: "x" });
		expect(!r.ok && r.error.type).toBe("RateLimited");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it.each([
		[401, "PermissionDenied"],
		[403, "PermissionDenied"],
		[500, "ExternalServiceUnavailable"],
		[400, "ValidationFailed"],
	])("%i は %s にする", async (status, type) => {
		const { port } = setup([json({}, status)]);
		const r = await port.sendText({ channelId: "2", text: "x" });
		expect(!r.ok && r.error.type).toBe(type);
	});

	it("403 は Discord の code と message を PermissionDenied に残す", async () => {
		const { port } = setup([
			json({ code: 50013, message: "Missing Permissions" }, 403),
		]);
		const r = await port.sendText({ channelId: "2", text: "x" });
		expect(!r.ok && r.error.type).toBe("PermissionDenied");
		expect(!r.ok && r.error.message).toContain(
			"403 code=50013 Missing Permissions",
		);
	});

	it("JSON でないエラー本文でも status だけで失敗を返す", async () => {
		const { port } = setup([
			new Response("<html>bad gateway</html>", { status: 502 }),
		]);
		const r = await port.sendText({ channelId: "2", text: "x" });
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
		expect(!r.ok && r.error.message).toContain("discord (502)");
		expect(!r.ok && r.error.message).not.toContain("html");
	});

	it("ネットワークエラーは ExternalServiceUnavailable", async () => {
		const { port } = setup([new Error("down")]);
		const r = await port.sendText({ channelId: "2", text: "x" });
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
	});
});

describe("sendTyping", () => {
	it("typing endpoint に body なしで POST する", async () => {
		const { port, fetchMock } = setup([new Response(null, { status: 204 })]);
		const r = await port.sendTyping({ channelId: "2" });
		expect(r.ok).toBe(true);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toBe("https://discord.com/api/v10/channels/2/typing");
		expect(init?.method).toBe("POST");
		expect(init?.body).toBeUndefined();
	});
});

describe("sendAttachment", () => {
	it("返事への返信として multipart で送る", async () => {
		const { port, fetchMock } = setup([json({ id: "501" })]);
		const r = await port.sendAttachment({
			channelId: "2",
			replyToMessageId: "500",
			filename: "voice.wav",
			contentType: "audio/wav",
			data: new Uint8Array([1, 2, 3]),
		});
		expect(r).toEqual({ ok: true, value: { messageId: "501" } });
		const init = fetchMock.mock.calls[0]?.[1];
		const form = init?.body as FormData;
		expect(form).toBeInstanceOf(FormData);
		expect(JSON.parse(String(form.get("payload_json")))).toEqual({
			allowed_mentions: { parse: [], replied_user: false },
			message_reference: { message_id: "500", fail_if_not_exists: false },
			attachments: [{ id: 0, filename: "voice.wav" }],
		});
		const file = form.get("files[0]") as File;
		expect(file.name).toBe("voice.wav");
		expect(file.type).toBe("audio/wav");
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		const h = init?.headers as Record<string, string>;
		expect(h["content-type"]).toBeUndefined();
	});

	it("返信先が無ければ message_reference を付けない", async () => {
		const { port, fetchMock } = setup([json({ id: "501" })]);
		await port.sendAttachment({
			channelId: "2",
			filename: "voice.wav",
			contentType: "audio/wav",
			data: new Uint8Array([1]),
		});
		const form = fetchMock.mock.calls[0]?.[1]?.body as FormData;
		expect(
			JSON.parse(String(form.get("payload_json"))).message_reference,
		).toBeUndefined();
	});

	it("429 の再送でも添付を送り直せる", async () => {
		const { port, fetchMock } = setup([
			json({ retry_after: 0.5 }, 429),
			json({ id: "501" }),
		]);
		const r = await port.sendAttachment({
			channelId: "2",
			replyToMessageId: "500",
			filename: "v.wav",
			contentType: "audio/wav",
			data: new Uint8Array([9]),
		});
		expect(r.ok).toBe(true);
		const second = fetchMock.mock.calls[1]?.[1]?.body as FormData;
		expect((second.get("files[0]") as File).size).toBe(1);
	});
});
