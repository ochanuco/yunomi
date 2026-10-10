import {
	type DomainError,
	type Envelope,
	envelopeSchema,
	err,
	ok,
	type Result,
	validationFailed,
} from "@yunomi/core";
import * as v from "valibot";

export const DISCORD_MESSAGE_CREATED = "discord.message.created";
export const DISCORD_SOURCE = "discord";

const snowflake = v.pipe(v.string(), v.nonEmpty());

export const discordMessageCreatedPayloadSchema = v.object({
	guild_id: snowflake,
	channel_id: snowflake,
	message_id: snowflake,
	author: v.object({
		id: snowflake,
		display_name: v.pipe(v.string(), v.nonEmpty()),
		is_bot: v.boolean(),
	}),
	content: v.string(),
	mentions: v.array(snowflake),
	reply_to_message_id: v.nullish(snowflake),
	attachments: v.array(
		v.object({
			name: v.string(),
			content_type: v.nullish(v.string()),
			size: v.pipe(v.number(), v.integer(), v.minValue(0)),
		}),
	),
});

export type DiscordMessageCreatedPayload = v.InferOutput<
	typeof discordMessageCreatedPayloadSchema
>;

/** Gateway → Yunomi のリクエスト。Envelope そのもの。 */
export const discordMessageCreatedEnvelopeSchema = v.pipe(
	envelopeSchema(discordMessageCreatedPayloadSchema),
	v.check(
		(e) => e.type === DISCORD_MESSAGE_CREATED,
		`type は ${DISCORD_MESSAGE_CREATED} でなければならない`,
	),
	v.check(
		(e) => e.source === DISCORD_SOURCE,
		`source は ${DISCORD_SOURCE} でなければならない`,
	),
);

export type DiscordMessageCreatedEnvelope = Envelope<
	typeof DISCORD_MESSAGE_CREATED,
	DiscordMessageCreatedPayload
>;

/** Yunomi → Gateway のレスポンス。content は Discord の 2000 文字制限に合わせる。 */
export const gatewayResponseSchema = v.variant("action", [
	v.object({
		action: v.literal("reply"),
		content: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
		reply_to_message_id: v.optional(snowflake),
		// DO が recent messages に積んだ自分の発言の id。送信後の sent 通知で Discord id と結び付ける
		partner_message_id: v.optional(v.pipe(v.string(), v.nonEmpty())),
	}),
	v.object({ action: v.literal("ignore") }),
]);

export type GatewayResponse = v.InferOutput<typeof gatewayResponseSchema>;

export const discordSentPathFor = (partnerId: string): string =>
	`/v1/partners/${encodeURIComponent(partnerId)}/discord/sent`;

/** Gateway → Yunomi。reply を Discord に送れたあと、その発言の Discord message id を知らせる。 */
export const discordSentSchema = v.object({
	partner_message_id: v.pipe(v.string(), v.nonEmpty()),
	channel_id: snowflake,
	discord_message_id: snowflake,
});

export type DiscordSent = v.InferOutput<typeof discordSentSchema>;

export type InboundMessage = {
	eventId: string;
	partnerId: string;
	source: string;
	guildId: string;
	channelId: string;
	messageId: string;
	author: { id: string; displayName: string; isBot: boolean };
	content: string;
	mentionedUserIds: string[];
	replyToMessageId: string | null;
	attachments: { name: string; contentType: string | null; size: number }[];
	occurredAt: Date;
	receivedAt: Date;
};

export const toInboundMessage = (
	input: unknown,
): Result<InboundMessage, DomainError> => {
	const parsed = v.safeParse(discordMessageCreatedEnvelopeSchema, input);
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
	const e = parsed.output;
	const p = e.payload;
	return ok({
		eventId: e.event_id,
		partnerId: e.partner_id,
		source: e.source,
		guildId: p.guild_id,
		channelId: p.channel_id,
		messageId: p.message_id,
		author: {
			id: p.author.id,
			displayName: p.author.display_name,
			isBot: p.author.is_bot,
		},
		content: p.content,
		mentionedUserIds: [...p.mentions],
		replyToMessageId: p.reply_to_message_id ?? null,
		attachments: p.attachments.map((a) => ({
			name: a.name,
			contentType: a.content_type ?? null,
			size: a.size,
		})),
		occurredAt: new Date(e.occurred_at),
		receivedAt: new Date(e.received_at),
	});
};

export const dedupeKey = (msg: Pick<InboundMessage, "messageId">): string =>
	`${DISCORD_SOURCE}:${msg.messageId}`;
