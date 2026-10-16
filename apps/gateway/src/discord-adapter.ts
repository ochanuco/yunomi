import type { Message, VoiceState } from "discord.js";
import type { MessageLike } from "./to-envelope.ts";
import type { VoiceStateLike } from "./voice-state.ts";

const mentionsBotRole = (m: Message): boolean => {
	const botRoleId = m.guild?.members.me?.roles.botRole?.id;
	return botRoleId !== undefined && m.mentions.roles.has(botRoleId);
};

/**
 * 中継するのは guild のテキストを送れるチャンネルの発言。DM は対象外。
 * VC のテキストチャット（GuildVoice）も通常のチャンネルと同じに扱う。
 */
export const isRelayable = (
	m: Message,
): m is Message<true> & { channel: Message<true>["channel"] } =>
	m.inGuild() && m.channel.isTextBased();

export const toMessageLike = (m: Message): MessageLike => ({
	id: m.id,
	guildId: m.guildId,
	channelId: m.channelId,
	content: m.content,
	createdAt: m.createdAt,
	author: {
		id: m.author.id,
		bot: m.author.bot,
		displayName: m.member?.displayName ?? m.author.displayName,
	},
	mentionedUserIds: [...m.mentions.users.keys()],
	mentionsBotRole: mentionsBotRole(m),
	replyToMessageId: m.reference?.messageId ?? null,
	authorVoiceChannelId: m.member?.voice.channelId ?? null,
	attachments: [...m.attachments.values()].map((a) => ({
		name: a.name,
		contentType: a.contentType,
		size: a.size,
	})),
});

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
