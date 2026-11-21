import { describe, expect, it, vi } from "vitest";
import { createSeatStatusClient } from "./seat-status-client.ts";

const client = (res: Response | Error) => {
	const fetch = vi.fn(async () => {
		if (res instanceof Error) throw res;
		return res;
	});
	return {
		fetch,
		c: createSeatStatusClient({
			url: "http://working.example:8191",
			token: "seat-token",
			partnerId: "akarin",
			fetch: fetch as unknown as typeof globalThis.fetch,
		}),
	};
};

describe("createSeatStatusClient", () => {
	it("自分のパートナーの口をトークン付きで読み、使用率を内部の形にする", async () => {
		const { c, fetch } = client(
			Response.json({
				working: 2,
				usage: {
					five_hour: { used_percent: 30.4, resets_at_ms: 1_793_000_000_000 },
					weekly: { used_percent: 12, resets_at_ms: null },
				},
			}),
		);
		expect(await c.seatSummary()).toEqual({
			ok: true,
			value: {
				working: 2,
				usage: {
					fiveHour: { usedPercent: 30.4, resetsAt: 1_793_000_000_000 },
					weekly: { usedPercent: 12, resetsAt: null },
				},
			},
		});
		const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
		expect(String(url)).toBe("http://working.example:8191/seat-status/akarin");
		expect(init.headers).toEqual({ authorization: "Bearer seat-token" });
	});

	it("使用率が読めていなければ null", async () => {
		const { c } = client(Response.json({ working: 0, usage: null }));
		expect(await c.seatSummary()).toEqual({
			ok: true,
			value: { working: 0, usage: null },
		});
	});

	it("2xx 以外・形の違う本文・通信の失敗は読めないことにする", async () => {
		for (const res of [
			new Response(null, { status: 401 }),
			Response.json({ working: -1, usage: null }),
			new Error("ECONNREFUSED"),
		]) {
			expect((await client(res).c.seatSummary()).ok).toBe(false);
		}
	});
});
