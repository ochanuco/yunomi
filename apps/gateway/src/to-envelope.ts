import type { DomainError } from "@yunomi/core";
import { err, newId, ok, type Result, validationFailed } from "@yunomi/core";
import {
	DISCORD_MESSAGE_CREATED,
	DISCORD_SOURCE,
	type DiscordMessageCreatedEnvelope,
	discordMessageCreatedEnvelopeSchema,
} from "@yunomi/protocol";
import * as v from "valibot";

/** discord.js の Message のうち Gateway が読む部分だけの構造型。 */
export type MessageLike = {
	id: string;
	guildId: string | null;
	channelId: string;
	content: string;
	createdAt: Date;
	author: { id: string; bot: boolean; displayName: string };
	mentionedUserIds: readonly string[];
	/** Discord の補完は bot 本人ではなく bot の管理ロールを選ぶことがあり、それも partner 宛てとみなす。 */
	mentionsBotRole: boolean;
	replyToMessageId: string | null;
	attachments: readonly {
		name: string;
		contentType: string | null;
		size: number;
	}[];
};

export type ToEnvelopeOptions = {
	partnerId: string;
	botUserId: string;
	now: Date;
};

export const toEnvelope = (
	message: MessageLike,
	{ partnerId, botUserId, now }: ToEnvelopeOptions,
): Result<DiscordMessageCreatedEnvelope, DomainError> => {
	if (message.author.id === botUserId) {
		return err(validationFailed({ issues: ["自分自身の発言は中継しない"] }));
	}
	const candidate = {
		event_id: newId(),
		type: DISCORD_MESSAGE_CREATED,
		source: DISCORD_SOURCE,
		partner_id: partnerId,
		occurred_at: message.createdAt.toISOString(),
		received_at: now.toISOString(),
		schema_version: 1,
		payload: {
			guild_id: message.guildId ?? "",
			channel_id: message.channelId,
			message_id: message.id,
			author: {
				id: message.author.id,
				display_name: message.author.displayName,
				is_bot: message.author.bot,
			},
			content: message.content,
			mentions: [
				...new Set([
					...message.mentionedUserIds,
					...(message.mentionsBotRole ? [botUserId] : []),
				]),
			],
			reply_to_message_id: message.replyToMessageId,
			attachments: message.attachments.map((a) => ({
				name: a.name,
				content_type: a.contentType,
				size: a.size,
			})),
		},
	};
	const parsed = v.safeParse(discordMessageCreatedEnvelopeSchema, candidate);
	if (!parsed.success) {
		return err(
			validationFailed({
				issues: parsed.issues.map((i) => {
					const path = v.getDotPath(i);
					return path ? `${path}: ${i.message}` : i.message;
				}),
			}),
		);
	}
	return ok(candidate as DiscordMessageCreatedEnvelope);
};
