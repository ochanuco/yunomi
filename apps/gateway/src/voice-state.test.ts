import { ok } from "@yunomi/core";
import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger.ts";
import { createVoiceStateHandler, type VoiceStateLike } from "./voice-state.ts";

const member = { id: "4", displayName: "alice", bot: false };
const state = (
	channelId: string | null,
	m: VoiceStateLike["member"] = member,
): VoiceStateLike => ({ guildId: "1", channelId, member: m });

const setup = (
	response: unknown = { action: "ignore" },
	partnerChannel: string | null = null,
) => {
	const client = { sendVoiceEvent: vi.fn(async (_e: unknown) => ok(response)) };
	const voice = {
		join: vi.fn(async (_g: string, _c: string) => {}),
		leave: vi.fn((_g: string) => {}),
		channelOf: vi.fn((_g: string) => partnerChannel),
	};
	const counts: Record<string, number> = { a: 2, b: 0, p: 3 };
	const handle = createVoiceStateHandler({
		client: client as never,
		voice,
		partnerId: "yukarin",
		botUserId: "999",
		countHumans: (_g, c) => counts[c] ?? 0,
		now: () => new Date("2026-01-01T00:00:00.000Z"),
		logger: silentLogger,
	});
	return { client, voice, handle };
};

describe("createVoiceStateHandler", () => {
	it("出入りを envelope にして POST する", async () => {
		const { client, handle } = setup({ action: "ignore" }, "p");
		await handle(state("b"), state("a"));
		const sent = client.sendVoiceEvent.mock.calls[0]?.[0];
		expect(sent).toMatchObject({
			type: "discord.voice_state.updated",
			source: "discord",
			partner_id: "yukarin",
			payload: {
				guild_id: "1",
				user: { id: "4", display_name: "alice", is_bot: false },
				from_channel_id: "b",
				to_channel_id: "a",
				humans_in_from: 0,
				humans_in_to: 2,
				partner_channel_id: "p",
				humans_in_partner_channel: 3,
			},
		});
	});

	it("VC に入っていなければ partner_channel_id は null で人数は 0", async () => {
		const { client, handle } = setup();
		await handle(state(null), state("a"));
		expect(client.sendVoiceEvent.mock.calls[0]?.[0]).toMatchObject({
			payload: {
				from_channel_id: null,
				humans_in_from: 0,
				partner_channel_id: null,
				humans_in_partner_channel: 0,
			},
		});
	});

	it("退出も送る（to が null）", async () => {
		const { client, handle } = setup();
		await handle(state("a"), state(null));
		expect(client.sendVoiceEvent.mock.calls[0]?.[0]).toMatchObject({
			payload: { from_channel_id: "a", to_channel_id: null, humans_in_to: 0 },
		});
	});

	it("partner 自身の変化は送らない", async () => {
		const { client, handle } = setup();
		const self = { id: "999", displayName: "yukarin", bot: true };
		await handle(state(null, self), state("a", self));
		expect(client.sendVoiceEvent).not.toHaveBeenCalled();
	});

	it("チャンネルが変わらない更新（ミュートなど）は送らない", async () => {
		const { client, handle } = setup();
		await handle(state("a"), state("a"));
		expect(client.sendVoiceEvent).not.toHaveBeenCalled();
	});

	it("voice_join で入る", async () => {
		const { voice, handle } = setup({
			action: "voice_join",
			guild_id: "1",
			channel_id: "a",
		});
		await handle(state(null), state("a"));
		expect(voice.join).toHaveBeenCalledWith("1", "a");
		expect(voice.leave).not.toHaveBeenCalled();
	});

	it("voice_leave で出る", async () => {
		const { voice, handle } = setup({ action: "voice_leave", guild_id: "1" });
		await handle(state("a"), state(null));
		expect(voice.leave).toHaveBeenCalledWith("1");
		expect(voice.join).not.toHaveBeenCalled();
	});

	it("ignore では何もしない", async () => {
		const { voice, handle } = setup({ action: "ignore" });
		await handle(state(null), state("a"));
		expect(voice.join).not.toHaveBeenCalled();
		expect(voice.leave).not.toHaveBeenCalled();
	});
});
