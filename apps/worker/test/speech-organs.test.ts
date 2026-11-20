import type { AivoiceValues } from "@yunomi/core";
import { describe, expect, it, vi } from "vitest";
import { createOchoko } from "../src/ochoko.ts";
import { composeVoiceOrgans } from "../src/voice-organs.ts";

const access = { clientId: "id", clientSecret: "secret" };

const values: AivoiceValues = {
	engine: "aivoice",
	preset: "結月 ゆかり",
	presetOverrides: { Styles: [{ Name: "J", Value: 0.5 }] },
	masterOverrides: {
		Volume: 1,
		Speed: 1,
		Pitch: 1,
		PitchRange: 1,
		MiddlePause: 150,
		LongPause: 370,
		SentencePause: 800,
	},
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const wav = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
const rpcOk = () =>
	json({
		jsonrpc: "2.0",
		id: 1,
		result: {
			content: [
				{
					type: "audio",
					data: btoa(String.fromCharCode(...wav)),
					mimeType: "audio/wav",
				},
				{ type: "text", text: "{}" },
			],
			structuredContent: { duration_ms: 1234, bytes: wav.length },
		},
	});

const ochoko = (fetch: typeof globalThis.fetch) =>
	createOchoko({
		baseUrl: "https://ochoko.example/",
		access,
		token: "tok",
		fetch,
	});

describe("ochoko synthesize", () => {
	it("tools/call を Access と Bearer つきで送り、WAV を base64 から戻す", async () => {
		const fetch = vi.fn(async () => rpcOk());
		const res = await ochoko(fetch).synthesize({ text: "こんにちは", values });

		expect(res).toEqual({
			ok: true,
			value: { audio: wav, contentType: "audio/wav", durationMs: 1234 },
		});
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://ochoko.example/mcp");
		const headers = new Headers(init.headers);
		expect(headers.get("cf-access-client-id")).toBe("id");
		expect(headers.get("cf-access-client-secret")).toBe("secret");
		expect(headers.get("authorization")).toBe("Bearer tok");
		expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
		expect(JSON.parse(init.body as string)).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "synthesize",
				arguments: {
					text: "こんにちは",
					preset: "結月 ゆかり",
					preset_overrides: values.presetOverrides,
					master_overrides: values.masterOverrides,
				},
			},
		});
	});

	it.each([
		[502, "ExternalServiceUnavailable"],
		[401, "PermissionDenied"],
		[429, "RateLimited"],
		[400, "ValidationFailed"],
	])("HTTP %i は %s にする", async (status, type) => {
		const res = await ochoko(
			async () => new Response("", { status }),
		).synthesize({
			text: "a",
			values,
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.type).toBe(type);
	});

	it("Access のログイン画面への redirect は PermissionDenied", async () => {
		const res = await ochoko(
			async () => new Response("", { status: 302 }),
		).synthesize({ text: "a", values });
		if (res.ok) throw new Error("ok になった");
		expect(res.error.type).toBe("PermissionDenied");
	});

	it("通信できないときは ExternalServiceUnavailable", async () => {
		const res = await ochoko(async () => {
			throw new TypeError("network");
		}).synthesize({ text: "a", values });
		if (res.ok) throw new Error("ok になった");
		expect(res.error.type).toBe("ExternalServiceUnavailable");
	});

	it("ツールのエラー（busy など）は再試行できる失敗", async () => {
		const res = await ochoko(async () =>
			json({
				jsonrpc: "2.0",
				id: 1,
				result: { isError: true, content: [{ type: "text", text: "busy" }] },
			}),
		).synthesize({ text: "a", values });
		if (res.ok) throw new Error("ok になった");
		expect(res.error).toMatchObject({
			type: "ExternalServiceUnavailable",
			retryable: true,
		});
	});

	it("JSON-RPC error と、音声のない応答は ValidationFailed", async () => {
		for (const body of [
			{ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } },
			{
				jsonrpc: "2.0",
				id: 1,
				result: { content: [{ type: "text", text: "x" }] },
			},
			{ unexpected: true },
		]) {
			const res = await ochoko(async () => json(body)).synthesize({
				text: "a",
				values,
			});
			if (res.ok) throw new Error("ok になった");
			expect(res.error.type).toBe("ValidationFailed");
		}
	});

	it("2000 文字を超える text は送らない", async () => {
		const fetch = vi.fn(async () => rpcOk());
		const res = await ochoko(fetch).synthesize({
			text: "あ".repeat(2001),
			values,
		});
		expect(res.ok).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("ochoko health", () => {
	const health = (engine: string, status = 200) =>
		ochoko(async () => json({ status: "ok", engine }, status)).health();

	it("engine の状態を可用性にする", async () => {
		expect(await health("ready")).toBe("ready");
		expect(await health("starting")).toBe("waking");
		expect(await health("unhealthy")).toBe("unavailable");
		expect(await health("unavailable")).toBe("unavailable");
	});

	it("Access ヘッダーつきで /healthz を呼ぶ", async () => {
		const fetch = vi.fn(async () => json({ status: "ok", engine: "ready" }));
		await ochoko(fetch).health();
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://ochoko.example/healthz");
		expect(new Headers(init.headers).get("cf-access-client-id")).toBe("id");
	});

	it("Tunnel の 502 と通信失敗は unreachable", async () => {
		expect(await health("ready", 502)).toBe("unreachable");
		expect(
			await ochoko(async () => {
				throw new Error("x");
			}).health(),
		).toBe("unreachable");
	});
});

describe("composeVoiceOrgans", () => {
	const at = new Date("2026-10-11T03:00:00Z");
	const compose = (engine: string) =>
		composeVoiceOrgans({
			ochoko: ochoko(async () => json({ status: "ok", engine })),
		});

	it("可用性は ochoko の healthz だけで決める", async () => {
		expect(await compose("ready").checkAvailability(at)).toEqual({
			organId: "ochoko",
			availability: "ready",
			checkedAt: at.toISOString(),
		});
		expect((await compose("starting").checkAvailability(at)).availability).toBe(
			"waking",
		);
	});
});
