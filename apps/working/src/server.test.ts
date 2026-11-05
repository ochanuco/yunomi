import type { AddressInfo } from "node:net";
import type { DiscordMessageCreatedEnvelope } from "@yunomi/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger.ts";
import { createWorkingServer } from "./server.ts";

const envelope = {
	event_id: "01890000-0000-7000-8000-000000000000",
	type: "discord.message.created",
	source: "discord",
	partner_id: "yukarin",
	occurred_at: "2026-11-05T08:00:00.000Z",
	received_at: "2026-11-05T08:00:00.000Z",
	schema_version: 1,
	payload: {
		guild_id: "g",
		channel_id: "c",
		message_id: "m",
		author: { id: "u", display_name: "U", is_bot: false },
		content: "hi",
		mentions: [],
		reply_to_message_id: null,
		attachments: [],
	},
};

let close = () => {};
afterEach(() => close());

const start = async () => {
	const accept = vi.fn<(e: DiscordMessageCreatedEnvelope) => void>();
	const server = createWorkingServer({
		sharedToken: "secret",
		accept,
		logger: silentLogger,
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	close = () => server.close();
	const { port } = server.address() as AddressInfo;
	return { accept, base: `http://127.0.0.1:${port}` };
};

const post = (url: string, body: unknown, token?: string) =>
	fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});

describe("createWorkingServer", () => {
	it("共有トークン付きの envelope を受け取り、処理を待たずに 202 を返す", async () => {
		const { accept, base } = await start();
		const res = await post(`${base}/events`, envelope, "secret");
		expect(res.status).toBe(202);
		expect(accept).toHaveBeenCalledWith(
			expect.objectContaining({ event_id: envelope.event_id }),
		);
	});

	it("トークンがない・違うときは 401 で、受け取らない", async () => {
		const { accept, base } = await start();
		expect((await post(`${base}/events`, envelope)).status).toBe(401);
		expect((await post(`${base}/events`, envelope, "wrong")).status).toBe(401);
		expect(accept).not.toHaveBeenCalled();
	});

	it("形の違う body は 400、知らない path は 404、healthz は 200", async () => {
		const { accept, base } = await start();
		expect((await post(`${base}/events`, { x: 1 }, "secret")).status).toBe(400);
		expect((await post(`${base}/other`, envelope, "secret")).status).toBe(404);
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
		expect(accept).not.toHaveBeenCalled();
	});
});
