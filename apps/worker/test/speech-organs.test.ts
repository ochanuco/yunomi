import type { AivoiceValues } from "@yunomi/core";
import { describe, expect, it, vi } from "vitest";
import { createOchoko } from "../src/ochoko.ts";
import { composeVoiceOrgans } from "../src/voice-organs.ts";
import { createWol } from "../src/wol.ts";

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

const wol = (fetch: typeof globalThis.fetch) =>
	createWol({ baseUrl: "https://wol.example", access, fetch });

describe("wol", () => {
	it.each([
		["online", "ready"],
		["waking", "waking"],
		["sleeping", "asleep"],
		["going_to_sleep", "asleep"],
		["offline", "asleep"],
	])("%s は %s", async (state, expected) => {
		const fetch = vi.fn(async () => json({ state }));
		expect(await wol(fetch).status()).toBe(expected);
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://wol.example/status");
		expect(new Headers(init.headers).get("cf-access-client-secret")).toBe(
			"secret",
		);
	});

	it("読めない応答と失敗は unreachable", async () => {
		expect(await wol(async () => json({ state: "?" })).status()).toBe(
			"unreachable",
		);
		expect(await wol(async () => json({}, 502)).status()).toBe("unreachable");
	});

	it("wake は POST /wake で、200 と 202 を成功にする", async () => {
		for (const status of [200, 202]) {
			const fetch = vi.fn(async () => new Response("{}", { status }));
			expect((await wol(fetch).wake()).ok).toBe(true);
			const [url, init] = fetch.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(url).toBe("https://wol.example/wake");
			expect(init.method).toBe("POST");
		}
	});

	it("wake の失敗を DomainError にする", async () => {
		const bad = await wol(async () => new Response("", { status: 403 })).wake();
		if (bad.ok) throw new Error("ok になった");
		expect(bad.error.type).toBe("PermissionDenied");
		const down = await wol(
			async () => new Response("", { status: 502 }),
		).wake();
		if (down.ok) throw new Error("ok になった");
		expect(down.error.type).toBe("ExternalServiceUnavailable");
	});
});

describe("composeVoiceOrgans", () => {
	const compose = (power: string, engine: string) => {
		const ochokoFetch = vi.fn(async () => json({ status: "ok", engine }));
		const organs = composeVoiceOrgans({
			ochoko: ochoko(ochokoFetch),
			wol: wol(async () => json({ state: power })),
		});
		return { organs, ochokoFetch };
	};
	const at = new Date("2026-10-11T03:00:00Z");

	it("寝ているときは ochoko に聞かない", async () => {
		const { organs, ochokoFetch } = compose("sleeping", "ready");
		expect(await organs.checkAvailability(at)).toEqual({
			organId: "ochoko",
			availability: "asleep",
			checkedAt: at.toISOString(),
		});
		expect(ochokoFetch).not.toHaveBeenCalled();
	});

	it("online のときだけ ochoko の healthz で決める", async () => {
		expect(
			(await compose("online", "ready").organs.checkAvailability(at))
				.availability,
		).toBe("ready");
		expect(
			(await compose("online", "starting").organs.checkAvailability(at))
				.availability,
		).toBe("waking");
	});
});
