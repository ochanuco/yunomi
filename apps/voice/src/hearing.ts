import { newId } from "@yunomi/core";
import {
	DISCORD_SOURCE,
	DISCORD_VOICE_UTTERANCE,
	type DiscordVoiceUtteranceEnvelope,
	discordVoiceUtteranceEnvelopeSchema,
	type GatewayResponse,
} from "@yunomi/protocol";
import * as v from "valibot";
import type { Utterance, Where } from "./ears.ts";
import type { KukichaClient } from "./kukicha-client.ts";
import type { Logger } from "./logger.ts";
import type { VoiceManager } from "./voice-manager.ts";
import type { YunomiClient } from "./yunomi-client.ts";

// 待たされた発話に今さら返事をしても会話がかみ合わないので、話し始めからこれを過ぎたら捨てる
const MAX_UTTERANCE_AGE_MS = 60_000;

export type HearingDeps = {
	kukicha: Pick<KukichaClient, "transcribe">;
	client: Pick<YunomiClient, "sendUtterance">;
	partnerId: string;
	ownerUserId: string;
	/** guild の member キャッシュにある表示名。見つからなければ null。 */
	displayNameOf: (guildId: string, userId: string) => string | null;
	/** guild でいま接続している VC。接続していなければ null。 */
	connectedChannelOf: (guildId: string) => string | null;
	voice: Pick<VoiceManager, "apply">;
	now?: () => Date;
	logger: Logger;
};

/**
 * 応答のうち声の指示だけを実行する。テキストと表情画像は Worker が REST で送る。
 * VC の操作は待たず、失敗はログに残す。
 */
const applyResponse = (
	deps: Pick<HearingDeps, "voice" | "logger">,
	response: GatewayResponse,
	logFields: Record<string, unknown>,
): void => {
	const log = deps.logger;
	if (response.action === "ignore") {
		log.info("ignored", logFields);
		return;
	}
	if (response.action === "reply") {
		// Worker が送信まで済ませていない。yunomi-voice はテキストを送らないので返事は届かない
		log.warn("reply not sent by voice", logFields);
	} else {
		log.info("acked", logFields);
	}
	void deps.voice.apply(response.voice).catch((e: unknown) => {
		log.error("voice directive failed", {
			...logFields,
			error: e instanceof Error ? e.name : "unknown",
		});
	});
};

/**
 * 聞いた発話を文字にして Worker に送り、応答の声の指示を実行する。
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
		const result = await deps.client.sendUtterance(envelope);
		if (!result.ok) {
			log.error("yunomi request failed", {
				event_id: envelope.event_id,
				error: result.error.type,
			});
			return;
		}
		applyResponse(deps, result.value, { event_id: envelope.event_id });
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
