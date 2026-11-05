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
		const client = createWorkingClient({ url: "http://w/inbox", fetch });
		expect(await client.forward(envelope)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(fetch).toHaveBeenCalledWith(
			"http://w/inbox",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify(envelope),
			}),
		);
	});

	it("エラー応答と通信失敗は投げずに err で返し、再送しない", async () => {
		const bad = vi.fn(async () => new Response(null, { status: 503 }));
		const r1 = await createWorkingClient({
			url: "http://w",
			fetch: bad,
		}).forward(envelope);
		expect(!r1.ok && r1.error.type).toBe("ExternalServiceUnavailable");
		expect(bad).toHaveBeenCalledTimes(1);

		const down = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		const r2 = await createWorkingClient({
			url: "http://w",
			fetch: down,
		}).forward(envelope);
		expect(!r2.ok && r2.error.type).toBe("ExternalServiceUnavailable");
	});
});
