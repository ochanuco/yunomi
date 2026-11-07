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
export const DISCORD_VOICE_UTTERANCE = "discord.voice.utterance";
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

const speakSchema = v.object({
	channel_id: snowflake,
	text: v.pipe(v.string(), v.minLength(1)),
	values: aivoiceValuesSchema,
});

export type SpeakDirective = v.InferOutput<typeof speakSchema>;

/** Worker が Gateway に頼む VC の操作。古い Gateway は無視する。 */
export const voiceDirectiveSchema = v.object({
	join: v.optional(v.object({ guild_id: snowflake, channel_id: snowflake })),
	leave: v.optional(v.object({ guild_id: snowflake })),
	// Gateway が values で合成して channel_id の VC で再生する。テキストは Worker が送り済み。
	// Worker と Gateway は別々に反映されるので、古い Gateway が読む speak（1 件目）を残し、
	// 全件は speak_queue に入れる。新しい Gateway は speak_queue があればそちらを順に再生する
	speak: v.optional(speakSchema),
	speak_queue: v.optional(v.pipe(v.array(speakSchema), v.minLength(1))),
});

export type VoiceDirective = v.InferOutput<typeof voiceDirectiveSchema>;

/**
 * 返事のまとまりのあとに Gateway が同じチャンネルへ貼る表情画像。古い Gateway は無視する。
 * 感情が増えたときに古い Gateway が応答ごと読めなくならないよう、emotion は picklist にしない。
 */
export const avatarDirectiveSchema = v.object({
	emotion: v.pipe(v.string(), v.nonEmpty()),
});

export type AvatarDirective = v.InferOutput<typeof avatarDirectiveSchema>;

/** Yunomi → Gateway のレスポンス。各 content は Discord の 2000 文字制限に合わせる。 */
export const gatewayResponseSchema = v.variant("action", [
	v.object({
		action: v.literal("reply"),
		// messages が無い古い Worker と、messages を知らない古い Gateway のために残す 1 通ぶんの欄
		content: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
		reply_to_message_id: v.optional(snowflake),
		// DO が recent messages に積んだ自分の発言の id。送信後の sent 通知で Discord id と結び付ける
		partner_message_id: v.optional(v.pipe(v.string(), v.nonEmpty())),
		// 順に送るメッセージ。あれば content の代わりに使う。reply_to_message_id は 1 件目にだけ使う
		messages: v.optional(
			v.pipe(
				v.array(
					v.object({
						content: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
						partner_message_id: v.optional(v.pipe(v.string(), v.nonEmpty())),
					}),
				),
				v.minLength(1),
				v.maxLength(10),
			),
		),
		voice: v.optional(voiceDirectiveSchema),
		avatar: v.optional(avatarDirectiveSchema),
	}),
	v.object({ action: v.literal("ignore") }),
	// Worker が Discord への送信まで済ませた。Gateway は VC の操作だけを実行する
	v.object({
		action: v.literal("ack"),
		voice: v.optional(voiceDirectiveSchema),
		avatar: v.optional(avatarDirectiveSchema),
	}),
]);

export type GatewayResponse = v.InferOutput<typeof gatewayResponseSchema>;

type ReplyResponse = Extract<GatewayResponse, { action: "reply" }>;
export type ReplyMessage = NonNullable<ReplyResponse["messages"]>[number];

/** reply で送るメッセージ。古い Worker の応答は content の 1 通として読む。 */
export const replyMessagesOf = (reply: ReplyResponse): ReplyMessage[] =>
	reply.messages ?? [
		{
			content: reply.content,
			...(reply.partner_message_id
				? { partner_message_id: reply.partner_message_id }
				: {}),
		},
	];

/** VC で読み上げる発話。古い Worker の応答は speak の 1 件として読む。 */
export const speakQueueOf = (
	directive: VoiceDirective | undefined,
): SpeakDirective[] =>
	directive?.speak_queue ?? (directive?.speak ? [directive.speak] : []);

const DISCORD_MAX_LENGTH = 2000;

/**
 * 複数件の返事を、古い Gateway でも送れる reply にする。
 * content は全件を改行でつなぎ、Discord の上限を超えるときは 1 件目だけにする。
 */
export const toReplyResponse = (input: {
	messages: readonly ReplyMessage[];
	replyToMessageId?: string;
}): ReplyResponse | null => {
	const [first] = input.messages;
	if (!first) return null;
	const joined = input.messages.map((m) => m.content).join("\n");
	return {
		action: "reply",
		content: joined.length <= DISCORD_MAX_LENGTH ? joined : first.content,
		...(first.partner_message_id
			? { partner_message_id: first.partner_message_id }
			: {}),
		...(input.replyToMessageId
			? { reply_to_message_id: input.replyToMessageId }
			: {}),
		messages: [...input.messages],
	};
};

/** 読み上げる発話を、古い Gateway が読む speak（1 件目）と全件の speak_queue に入れる。 */
export const withSpeakQueue = (
	directive: Omit<VoiceDirective, "speak" | "speak_queue">,
	queue: readonly SpeakDirective[],
): VoiceDirective => {
	const [first] = queue;
	return first
		? { ...directive, speak: first, speak_queue: [...queue] }
		: { ...directive };
};

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
	// 接続先の VC で相手の声を受け取っているか。耳を持たない古い Gateway は省略する
	listening: v.optional(v.boolean()),
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
	/** text は書かれた発言、voice は VC で聞き取った発話。 */
	modality: "text" | "voice";
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
		modality: "text",
		occurredAt: new Date(e.occurred_at),
		receivedAt: new Date(e.received_at),
	});
};

export const dedupeKey = (msg: Pick<InboundMessage, "messageId">): string =>
	`${DISCORD_SOURCE}:${msg.messageId}`;

/** Gateway → Yunomi。VC で聞き取った 1 つの発話。occurred_at は話し始めた時刻。 */
export const discordVoiceUtterancePayloadSchema = v.object({
	guild_id: snowflake,
	// 発話を聞いた VC。返事もこの VC のテキストチャットと声で返す
	channel_id: snowflake,
	author: v.object({
		id: snowflake,
		display_name: v.pipe(v.string(), v.nonEmpty()),
	}),
	text: v.pipe(v.string(), v.trim(), v.nonEmpty()),
	duration_ms: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export type DiscordVoiceUtterancePayload = v.InferOutput<
	typeof discordVoiceUtterancePayloadSchema
>;

export const discordVoiceUtteranceEnvelopeSchema = v.pipe(
	envelopeSchema(discordVoiceUtterancePayloadSchema),
	v.check(
		(e) => e.type === DISCORD_VOICE_UTTERANCE,
		`type は ${DISCORD_VOICE_UTTERANCE} でなければならない`,
	),
	v.check(
		(e) => e.source === DISCORD_SOURCE,
		`source は ${DISCORD_SOURCE} でなければならない`,
	),
);

export type DiscordVoiceUtteranceEnvelope = Envelope<
	typeof DISCORD_VOICE_UTTERANCE,
	DiscordVoiceUtterancePayload
>;

export type HeardUtterance = {
	eventId: string;
	partnerId: string;
	source: string;
	guildId: string;
	channelId: string;
	author: { id: string; displayName: string };
	text: string;
	durationMs: number;
	occurredAt: Date;
	receivedAt: Date;
};

export const toHeardUtterance = (
	input: unknown,
): Result<HeardUtterance, DomainError> => {
	const parsed = v.safeParse(discordVoiceUtteranceEnvelopeSchema, input);
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
		author: { id: p.author.id, displayName: p.author.display_name },
		text: p.text,
		durationMs: p.duration_ms,
		occurredAt: new Date(e.occurred_at),
		receivedAt: new Date(e.received_at),
	});
};

/** 発話には Discord の message id が無いので、Envelope の event_id で重複を見る。 */
export const heardDedupeKey = (u: Pick<HeardUtterance, "eventId">): string =>
	`${DISCORD_SOURCE}-voice:${u.eventId}`;

/**
 * 聞いた発話を、VC での発言としてターンに乗せる。
 * Discord の発言ではないので messageId は event_id から作る。Discord の返信形式の宛先にはできない。
 */
export const heardToInbound = (u: HeardUtterance): InboundMessage => ({
	eventId: u.eventId,
	partnerId: u.partnerId,
	source: u.source,
	guildId: u.guildId,
	channelId: u.channelId,
	messageId: `voice:${u.eventId}`,
	author: { id: u.author.id, displayName: u.author.displayName, isBot: false },
	content: u.text,
	mentionedUserIds: [],
	authorVoiceChannelId: u.channelId,
	replyToMessageId: null,
	attachments: [],
	modality: "voice",
	occurredAt: u.occurredAt,
	receivedAt: u.receivedAt,
});
