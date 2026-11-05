import type { DiscordMessageCreatedEnvelope } from "@yunomi/protocol";
import { describe, expect, it, vi } from "vitest";
import { createWorkingClient } from "./working-client.ts";

const envelope = {
	event_id: "e1",
	payload: { message_id: "3" },
} as unknown as DiscordMessageCreatedEnvelope;

describe("createWorkingClient", () => {
	it("envelope を JSON で設定された URL に POST する", async () => {
		const fetch = vi.fn(async () => new Response(null, { status: 202 }));
		const client = createWorkingClient({
			url: "http://w/inbox",
			token: "secret",
			fetch,
		});
		expect(await client.forward(envelope)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(fetch).toHaveBeenCalledWith(
			"http://w/inbox",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ authorization: "Bearer secret" }),
				body: JSON.stringify(envelope),
			}),
		);
	});

	it("エラー応答と通信失敗は投げずに err で返し、再送しない", async () => {
		const bad = vi.fn(async () => new Response(null, { status: 503 }));
		const r1 = await createWorkingClient({
			url: "http://w",
			token: "secret",
			fetch: bad,
		}).forward(envelope);
		expect(!r1.ok && r1.error.type).toBe("ExternalServiceUnavailable");
		expect(bad).toHaveBeenCalledTimes(1);

		const down = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		const r2 = await createWorkingClient({
			url: "http://w",
			token: "secret",
			fetch: down,
		}).forward(envelope);
		expect(!r2.ok && r2.error.type).toBe("ExternalServiceUnavailable");
	});

	it("席の数は同じ受付の /seats/summary から Bearer 付きで読み、形が違えば err で返す", async () => {
		const fetch = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				Response.json({ working: 3 }),
		);
		const client = createWorkingClient({
			url: "http://w:8080/events",
			token: "secret",
			fetch,
		});
		expect(await client.seatSummary()).toEqual({
			ok: true,
			value: { working: 3 },
		});
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(String(url)).toBe("http://w:8080/seats/summary");
		expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });

		const bad = createWorkingClient({
			url: "http://w/events",
			token: "secret",
			fetch: vi.fn(async () => Response.json({ working: "x" })),
		});
		const r = await bad.seatSummary();
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
	});
});
