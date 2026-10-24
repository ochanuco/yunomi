import { newId } from "@yunomi/core";
import {
	DISCORD_SOURCE,
	DISCORD_VOICE_UTTERANCE,
	type DiscordVoiceUtteranceEnvelope,
	discordVoiceUtteranceEnvelopeSchema,
} from "@yunomi/protocol";
import * as v from "valibot";
import type { AvatarStock } from "./avatar-stock.ts";
import { applyVoice, type ChannelLike, deliverResponse } from "./deliver.ts";
import type { Utterance, Where } from "./ears.ts";
import type { KukichaClient } from "./kukicha-client.ts";
import type { Logger } from "./logger.ts";
import type { VoiceManager } from "./voice-manager.ts";
import type { YunomiClient } from "./yunomi-client.ts";

// 待たされた発話に今さら返事をしても会話がかみ合わないので、話し始めからこれを過ぎたら捨てる
const MAX_UTTERANCE_AGE_MS = 60_000;

export type HearingDeps = {
	kukicha: Pick<KukichaClient, "transcribe">;
	client: Pick<YunomiClient, "send" | "notifySent">;
	partnerId: string;
	ownerUserId: string;
	/** guild の member キャッシュにある表示名。見つからなければ null。 */
	displayNameOf: (guildId: string, userId: string) => string | null;
	/** VC のテキストチャット。見つからなければ null。 */
	channelOf: (channelId: string) => ChannelLike | null;
	/** guild でいま接続している VC。接続していなければ null。 */
	connectedChannelOf: (guildId: string) => string | null;
	voice?: Pick<VoiceManager, "apply">;
	avatars?: Pick<AvatarStock, "pick">;
	now?: () => Date;
	logger: Logger;
};

/**
 * 聞いた発話を文字にして Worker に送り、応答を実行する。
 * 返事の順が話した順とずれないよう、VC ごとに前の発話を終えてから次を扱う。
 */
export const createHearing = (deps: HearingDeps) => {
	const log = deps.logger;
	const now = deps.now ?? (() => new Date());
	const tails = new Map<string, Promise<void>>();

	/** 待たされて古くなった発話や、もう出た VC の発話は扱わない。 */
	const stale = (u: Utterance, where: Where, stage: string): boolean => {
		const at = { guild_id: where.guildId, channel_id: where.channelId };
		const ageMs = now().getTime() - u.startedAt.getTime();
		if (ageMs > MAX_UTTERANCE_AGE_MS) {
			log.debug("utterance too old", { ...at, stage, age_ms: ageMs });
			return true;
		}
		if (deps.connectedChannelOf(where.guildId) !== where.channelId) {
			log.debug("utterance from left channel", { ...at, stage });
			return true;
		}
		return false;
	};

	const handle = async (u: Utterance, where: Where): Promise<void> => {
		const at = { guild_id: where.guildId, channel_id: where.channelId };
		if (stale(u, where, "transcribe")) return;
		const transcript = await deps.kukicha.transcribe({
			wav: u.wav,
			speaker: deps.ownerUserId,
		});
		if (!transcript.ok) {
			log.warn("utterance dropped", {
				...at,
				duration_ms: u.durationMs,
				error: transcript.error.type,
			});
			return;
		}
		const text = transcript.value.text.trim();
		if (!text) {
			log.debug("utterance empty", { ...at, duration_ms: u.durationMs });
			return;
		}

		const envelope: DiscordVoiceUtteranceEnvelope = {
			event_id: newId(),
			type: DISCORD_VOICE_UTTERANCE,
			source: DISCORD_SOURCE,
			partner_id: deps.partnerId,
			occurred_at: u.startedAt.toISOString(),
			received_at: now().toISOString(),
			schema_version: 1,
			payload: {
				guild_id: where.guildId,
				channel_id: where.channelId,
				author: {
					id: deps.ownerUserId,
					display_name:
						deps.displayNameOf(where.guildId, deps.ownerUserId) ??
						deps.ownerUserId,
				},
				text,
				duration_ms: Math.max(
					1,
					Math.round(transcript.value.durationMs || u.durationMs),
				),
			},
		};
		const parsed = v.safeParse(discordVoiceUtteranceEnvelopeSchema, envelope);
		if (!parsed.success) {
			log.warn("utterance dropped", {
				...at,
				duration_ms: u.durationMs,
				error: "ValidationFailed",
			});
			return;
		}
		log.info("utterance transcribed", {
			...at,
			event_id: envelope.event_id,
			duration_ms: u.durationMs,
			chars: text.length,
		});

		if (stale(u, where, "send")) return;
		const result = await deps.client.send(envelope);
		if (!result.ok) {
			log.error("yunomi request failed", {
				event_id: envelope.event_id,
				error: result.error.type,
			});
			return;
		}
		const response = result.value;
		const channel = deps.channelOf(where.channelId);
		if (!channel) {
			log.warn("voice text channel not found", at);
			if (response.action !== "ignore") {
				applyVoice(deps, response.voice, { event_id: envelope.event_id });
			}
			return;
		}
		await deliverResponse(deps, response, {
			channel,
			channelId: where.channelId,
			logFields: { event_id: envelope.event_id },
			// 発話には Discord のメッセージが無いので、返信形式の宛先が無い
			replyTo: () => null,
		});
	};

	return (u: Utterance, where: Where): Promise<void> => {
		const key = `${where.guildId}/${where.channelId}`;
		const next = (tails.get(key) ?? Promise.resolve())
			.then(() => handle(u, where))
			.catch((e: unknown) => {
				log.error("utterance handler crashed", {
					error: e instanceof Error ? e.name : "unknown",
				});
			});
		tails.set(key, next);
		void next.then(() => {
			if (tails.get(key) === next) tails.delete(key);
		});
		return next;
	};
};
