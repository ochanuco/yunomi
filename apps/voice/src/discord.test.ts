import { GatewayIntentBits, IntentsBitField } from "discord.js";
import { describe, expect, it } from "vitest";
import { countHumans, createDiscordClient } from "./discord.ts";

describe("createDiscordClient", () => {
	it("intent は Guilds と GuildVoiceStates だけ", () => {
		const client = createDiscordClient();
		const intents = new IntentsBitField(client.options.intents);
		expect(intents.toArray().sort()).toEqual(["GuildVoiceStates", "Guilds"]);
		expect(intents.has(GatewayIntentBits.GuildMessages)).toBe(false);
		expect(intents.has(GatewayIntentBits.MessageContent)).toBe(false);
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
