import { ChannelType } from "discord.js";
import { describe, expect, it } from "vitest";
import { countHumans, isRelayable, toMessageLike } from "./discord-adapter.ts";

const fakeMessage = (over: Record<string, unknown> = {}) =>
	({
		id: "3",
		guildId: "1",
		channelId: "2",
		content: "hi",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		author: { id: "4", bot: false, displayName: "alice" },
		member: { displayName: "Alice", voice: { channelId: "vc1" } },
		mentions: { users: new Map(), roles: new Map() },
		guild: { members: { me: { roles: { botRole: null } } } },
		reference: null,
		attachments: new Map(),
		channel: { type: ChannelType.GuildVoice, isTextBased: () => true },
		inGuild: () => true,
		...over,
	}) as never;

describe("isRelayable", () => {
	it("VC のテキストチャットも中継する", () => {
		expect(isRelayable(fakeMessage())).toBe(true);
	});

	it("DM は中継しない", () => {
		expect(isRelayable(fakeMessage({ inGuild: () => false }))).toBe(false);
	});

	it("テキストを送れないチャンネルは中継しない", () => {
		expect(
			isRelayable(fakeMessage({ channel: { isTextBased: () => false } })),
		).toBe(false);
	});
});

describe("toMessageLike", () => {
	it("作者がいる VC を authorVoiceChannelId に載せる", () => {
		expect(toMessageLike(fakeMessage()).authorVoiceChannelId).toBe("vc1");
	});

	it("VC にいなければ null", () => {
		const m = fakeMessage({
			member: { displayName: "Alice", voice: { channelId: null } },
		});
		expect(toMessageLike(m).authorVoiceChannelId).toBeNull();
		expect(
			toMessageLike(fakeMessage({ member: null })).authorVoiceChannelId,
		).toBeNull();
	});
});

describe("countHumans", () => {
	it("指定の VC にいる bot 以外だけを数える", () => {
		const state = (channelId: string | null, bot: boolean | undefined) =>
			({
				channelId,
				member: bot === undefined ? null : { user: { bot } },
			}) as never;
		const guild = {
			voiceStates: {
				cache: new Map([
					["a", state("vc1", false)],
					["b", state("vc1", false)],
					["c", state("vc1", true)],
					["d", state("vc2", false)],
					["e", state("vc1", undefined)],
				]),
			},
		};
		expect(countHumans(guild, "vc1")).toBe(2);
		expect(countHumans(undefined, "vc1")).toBe(0);
	});
});
