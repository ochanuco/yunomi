import type { Channel, Message } from "discord.js";
import type { MessageLike } from "./to-envelope.ts";

const roleMentionedBotUserIds = (m: Message): string[] =>
	[...m.mentions.roles.values()]
		.map((role) => role.tags?.botId)
		.filter((id) => id != null);

const categoryIdOf = (channel: Channel | null): string | null => {
	if (channel === null) return null;
	if (channel.isThread()) return channel.parent?.parentId ?? null;
	return "parentId" in channel ? (channel.parentId ?? null) : null;
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
	roleMentionedBotUserIds: roleMentionedBotUserIds(m),
	replyToMessageId: m.reference?.messageId ?? null,
	categoryId: categoryIdOf(m.channel),
	authorVoiceChannelId: m.member?.voice.channelId ?? null,
	attachments: [...m.attachments.values()].map((a) => ({
		name: a.name,
		contentType: a.contentType,
		size: a.size,
	})),
});
