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
export const DISCORD_VOICE_STATE_UPDATED = "discord.voice_state.updated";
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
	// 作者がいま入っている VC（Gateway から見えるもの）。入っていなければ null、古い Gateway は省略
	author_voice_channel_id: v.nullish(snowflake),
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

const aivoiceValuesSchema = v.object({
	engine: v.literal("aivoice"),
	preset: v.string(),
	presetOverrides: v.object({
		Styles: v.optional(
			v.array(v.object({ Name: v.string(), Value: v.number() })),
		),
	}),
	masterOverrides: v.object({
		Volume: v.number(),
		Speed: v.number(),
		Pitch: v.number(),
		PitchRange: v.number(),
		MiddlePause: v.number(),
		LongPause: v.number(),
		SentencePause: v.number(),
	}),
});

/** Worker が Gateway に頼む VC の操作。古い Gateway は無視する。 */
export const voiceDirectiveSchema = v.object({
	join: v.optional(v.object({ guild_id: snowflake, channel_id: snowflake })),
	leave: v.optional(v.object({ guild_id: snowflake })),
	// Gateway が values で合成して channel_id の VC で順に再生する。テキストは Worker が送り済み
	speak: v.optional(
		v.pipe(
			v.array(
				v.object({
					channel_id: snowflake,
					text: v.pipe(v.string(), v.minLength(1)),
					values: aivoiceValuesSchema,
				}),
			),
			v.minLength(1),
		),
	),
});

export type VoiceDirective = v.InferOutput<typeof voiceDirectiveSchema>;

/** Yunomi → Gateway のレスポンス。各 content は Discord の 2000 文字制限に合わせる。 */
export const gatewayResponseSchema = v.variant("action", [
	v.object({
		action: v.literal("reply"),
		// 順に送る。reply_to_message_id は 1 件目にだけ使う
		messages: v.pipe(
			v.array(
				v.object({
					content: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
					// DO が recent messages に積んだ自分の発言の id。送信後の sent 通知で Discord id と結び付ける
					partner_message_id: v.optional(v.pipe(v.string(), v.nonEmpty())),
				}),
			),
			v.minLength(1),
			v.maxLength(10),
		),
		reply_to_message_id: v.optional(snowflake),
		voice: v.optional(voiceDirectiveSchema),
	}),
	v.object({ action: v.literal("ignore") }),
	// Worker が Discord への送信まで済ませた。Gateway は VC の操作だけを実行する
	v.object({
		action: v.literal("ack"),
		voice: v.optional(voiceDirectiveSchema),
	}),
]);

export type GatewayResponse = v.InferOutput<typeof gatewayResponseSchema>;

export const discordSentPathFor = (partnerId: string): string =>
	`/v1/partners/${encodeURIComponent(partnerId)}/discord/sent`;

/** Gateway → Yunomi。Gateway が reply を Discord に送れたあと、その発言の Discord message id を知らせる。 */
export const discordSentSchema = v.object({
	partner_message_id: v.pipe(v.string(), v.nonEmpty()),
	channel_id: snowflake,
	discord_message_id: snowflake,
});

export type DiscordSent = v.InferOutput<typeof discordSentSchema>;

export const DISCORD_VOICE_EVENTS_PATH = "/v1/interfaces/discord/voice-events";

export const discordVoiceStateUpdatedPayloadSchema = v.object({
	guild_id: snowflake,
	// 状態が変わったユーザー
	user: v.object({
		id: snowflake,
		display_name: v.pipe(v.string(), v.nonEmpty()),
		is_bot: v.boolean(),
	}),
	from_channel_id: v.nullable(snowflake),
	to_channel_id: v.nullable(snowflake),
	// 変化後の bot 以外の人数。partner bot は数えない
	humans_in_from: v.pipe(v.number(), v.integer(), v.minValue(0)),
	humans_in_to: v.pipe(v.number(), v.integer(), v.minValue(0)),
	// partner bot がいま実際に接続している VC（Gateway から見えるもの）
	partner_channel_id: v.nullable(snowflake),
	humans_in_partner_channel: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type DiscordVoiceStateUpdatedPayload = v.InferOutput<
	typeof discordVoiceStateUpdatedPayloadSchema
>;

export const discordVoiceStateUpdatedEnvelopeSchema = v.pipe(
	envelopeSchema(discordVoiceStateUpdatedPayloadSchema),
	v.check(
		(e) => e.type === DISCORD_VOICE_STATE_UPDATED,
		`type は ${DISCORD_VOICE_STATE_UPDATED} でなければならない`,
	),
	v.check(
		(e) => e.source === DISCORD_SOURCE,
		`source は ${DISCORD_SOURCE} でなければならない`,
	),
);

/** voice-events のレスポンス。Gateway はこの指示どおりに VC へ入る・出る。 */
export const voiceResponseSchema = v.variant("action", [
	v.object({
		action: v.literal("voice_join"),
		guild_id: snowflake,
		channel_id: snowflake,
	}),
	v.object({ action: v.literal("voice_leave"), guild_id: snowflake }),
	v.object({ action: v.literal("ignore") }),
]);

export type VoiceResponse = v.InferOutput<typeof voiceResponseSchema>;

export type VoiceStateUpdate = {
	eventId: string;
	partnerId: string;
	guildId: string;
	user: { id: string; displayName: string; isBot: boolean };
	fromChannelId: string | null;
	toChannelId: string | null;
	humansInFrom: number;
	humansInTo: number;
	partnerChannelId: string | null;
	humansInPartnerChannel: number;
	occurredAt: Date;
};

export const toVoiceStateUpdate = (
	input: unknown,
): Result<VoiceStateUpdate, DomainError> => {
	const parsed = v.safeParse(discordVoiceStateUpdatedEnvelopeSchema, input);
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
		guildId: p.guild_id,
		user: {
			id: p.user.id,
			displayName: p.user.display_name,
			isBot: p.user.is_bot,
		},
		fromChannelId: p.from_channel_id,
		toChannelId: p.to_channel_id,
		humansInFrom: p.humans_in_from,
		humansInTo: p.humans_in_to,
		partnerChannelId: p.partner_channel_id,
		humansInPartnerChannel: p.humans_in_partner_channel,
		occurredAt: new Date(e.occurred_at),
	});
};

export const discordVoiceConnectionPathFor = (partnerId: string): string =>
	`/v1/partners/${encodeURIComponent(partnerId)}/discord/voice-connection`;

/** Gateway → Yunomi。VC に実際に接続・切断できたあと、いまの接続先を知らせる。起動時は null で送る。 */
export const discordVoiceConnectionSchema = v.object({
	guild_id: snowflake,
	channel_id: v.nullable(snowflake),
});

export type DiscordVoiceConnection = v.InferOutput<
	typeof discordVoiceConnectionSchema
>;

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
	authorVoiceChannelId: string | null;
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
		authorVoiceChannelId: p.author_voice_channel_id ?? null,
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
