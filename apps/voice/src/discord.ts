import { Client, GatewayIntentBits, type VoiceState } from "discord.js";
import type { VoiceStateLike } from "./voice-state.ts";

// テキストは relay が受け持つ。同じ bot で Gateway にもう 1 本つなぐので、発言の intent は持たない
export const VOICE_INTENTS = [
	GatewayIntentBits.Guilds,
	GatewayIntentBits.GuildVoiceStates,
] as const;

export const createDiscordClient = (): Client =>
	new Client({ intents: [...VOICE_INTENTS] });

export const toVoiceStateLike = (s: VoiceState): VoiceStateLike => ({
	guildId: s.guild.id,
	channelId: s.channelId,
	member: s.member
		? {
				id: s.member.id,
				displayName: s.member.displayName,
				bot: s.member.user.bot,
			}
		: null,
});

/** bot を除いた、VC にいる人数。 */
export const countHumans = (
	guild: { voiceStates: { cache: Map<string, VoiceState> } } | undefined,
	channelId: string,
): number => {
	if (!guild) return 0;
	let n = 0;
	for (const s of guild.voiceStates.cache.values()) {
		if (s.channelId === channelId && s.member?.user.bot === false) n++;
	}
	return n;
};
