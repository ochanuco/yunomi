import type { DomainError } from "@yunomi/core";
import { err, newId, ok, type Result, validationFailed } from "@yunomi/core";
import {
	DISCORD_SOURCE,
	DISCORD_VOICE_STATE_UPDATED,
	type DiscordVoiceStateUpdatedPayload,
	discordVoiceStateUpdatedEnvelopeSchema,
} from "@yunomi/protocol";
import * as v from "valibot";
import type { Logger } from "./logger.ts";
import type { VoiceManager } from "./voice-manager.ts";
import type { YunomiClient } from "./yunomi-client.ts";

/** discord.js の VoiceState のうち Gateway が読む部分だけの構造型。 */
export type VoiceStateLike = {
	guildId: string;
	channelId: string | null;
	member: { id: string; displayName: string; bot: boolean } | null;
};

type VoiceEnvelope = {
	event_id: string;
	type: typeof DISCORD_VOICE_STATE_UPDATED;
	source: typeof DISCORD_SOURCE;
	partner_id: string;
	occurred_at: string;
	received_at: string;
	schema_version: 1;
	payload: DiscordVoiceStateUpdatedPayload;
};

export const toVoiceEnvelope = (
	partnerId: string,
	now: Date,
	payload: DiscordVoiceStateUpdatedPayload,
): Result<VoiceEnvelope, DomainError> => {
	const candidate = {
		event_id: newId(),
		type: DISCORD_VOICE_STATE_UPDATED,
		source: DISCORD_SOURCE,
		partner_id: partnerId,
		occurred_at: now.toISOString(),
		received_at: now.toISOString(),
		schema_version: 1,
		payload,
	};
	const parsed = v.safeParse(discordVoiceStateUpdatedEnvelopeSchema, candidate);
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
	return ok(candidate as VoiceEnvelope);
};

export type VoiceStateHandlerDeps = {
	client: Pick<YunomiClient, "sendVoiceEvent">;
	voice: Pick<VoiceManager, "join" | "leave" | "channelOf">;
	partnerId: string;
	botUserId: string;
	/** bot を除いた、その VC にいる人数。 */
	countHumans: (guildId: string, channelId: string) => number;
	now?: () => Date;
	logger: Logger;
};

export const createVoiceStateHandler =
	(deps: VoiceStateHandlerDeps) =>
	async (oldState: VoiceStateLike, newState: VoiceStateLike): Promise<void> => {
		const log = deps.logger;
		const member = newState.member ?? oldState.member;
		if (!member || member.id === deps.botUserId) return;
		// ミュートや配信の切り替えは VC の出入りではない
		if (oldState.channelId === newState.channelId) return;

		const guildId = newState.guildId;
		const count = (channelId: string | null) =>
			channelId === null ? 0 : deps.countHumans(guildId, channelId);
		const partnerChannelId = deps.voice.channelOf(guildId);
		const envelope = toVoiceEnvelope(
			deps.partnerId,
			(deps.now ?? (() => new Date()))(),
			{
				guild_id: guildId,
				user: {
					id: member.id,
					display_name: member.displayName,
					is_bot: member.bot,
				},
				from_channel_id: oldState.channelId,
				to_channel_id: newState.channelId,
				humans_in_from: count(oldState.channelId),
				humans_in_to: count(newState.channelId),
				partner_channel_id: partnerChannelId,
				humans_in_partner_channel: count(partnerChannelId),
			},
		);
		if (!envelope.ok) {
			log.warn("voice event skipped", { issues: envelope.error.type });
			return;
		}

		const result = await deps.client.sendVoiceEvent(envelope.value);
		if (!result.ok) {
			log.error("yunomi voice request failed", {
				event_id: envelope.value.event_id,
				error: result.error.type,
			});
			return;
		}
		const response = result.value;
		if (response.action === "voice_join") {
			await deps.voice.join(response.guild_id, response.channel_id);
		} else if (response.action === "voice_leave") {
			deps.voice.leave(response.guild_id);
		} else {
			log.debug("voice event ignored", { event_id: envelope.value.event_id });
		}
	};
