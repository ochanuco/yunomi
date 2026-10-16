import { env } from "cloudflare:workers";
import type { InboundMessage } from "@yunomi/protocol";

export const PARTNER_ID = "yukarin";

let seq = 0;

export const inbound = (over: Partial<InboundMessage> = {}): InboundMessage => {
	seq += 1;
	return {
		eventId: crypto.randomUUID(),
		partnerId: PARTNER_ID,
		source: "discord",
		guildId: "g1",
		channelId: "c1",
		messageId: `m${seq}`,
		author: { id: "u1", displayName: "alice", isBot: false },
		content: "こんにちは",
		mentionedUserIds: [],
		authorVoiceChannelId: null,
		replyToMessageId: null,
		attachments: [],
		occurredAt: new Date("2026-10-11T03:00:00Z"),
		receivedAt: new Date("2026-10-11T03:00:01Z"),
		...over,
	};
};

export const envelopeBody = (msg: InboundMessage) => ({
	event_id: msg.eventId,
	type: "discord.message.created",
	source: "discord",
	partner_id: msg.partnerId,
	occurred_at: msg.occurredAt.toISOString(),
	received_at: msg.receivedAt.toISOString(),
	schema_version: 1,
	payload: {
		guild_id: msg.guildId,
		channel_id: msg.channelId,
		message_id: msg.messageId,
		author: {
			id: msg.author.id,
			display_name: msg.author.displayName,
			is_bot: msg.author.isBot,
		},
		content: msg.content,
		mentions: msg.mentionedUserIds,
		author_voice_channel_id: msg.authorVoiceChannelId,
		reply_to_message_id: msg.replyToMessageId,
		attachments: [],
	},
});

export const partnerStub = (name = PARTNER_ID) => {
	const ns = env.PARTNER as DurableObjectNamespace<
		import("../src/index.ts").PartnerDO
	>;
	return ns.get(ns.idFromName(name));
};
