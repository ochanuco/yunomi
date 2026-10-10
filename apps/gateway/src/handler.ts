import type { Logger } from "./logger.ts";
import { type MessageLike, toEnvelope } from "./to-envelope.ts";
import type { YunomiClient } from "./yunomi-client.ts";

export const TYPING_INTERVAL_MS = 8000;
// 前段ルールで決まる ignore はすぐ返る。宛先でない発言のたびに typing を出さないよう、応答が遅いときだけ出す。
export const TYPING_DELAY_MS = 1500;

/** discord.js のテキストチャンネルのうち handler が使う部分。 */
export type ChannelLike = {
	sendTyping: () => Promise<unknown>;
	send: (options: {
		content: string;
		reply: { messageReference: string; failIfNotExists: boolean };
		allowedMentions: { repliedUser: boolean; parse: never[] };
	}) => Promise<{ id: string }>;
};

export type HandlerDeps = {
	client: Pick<YunomiClient, "send" | "notifySent">;
	partnerId: string;
	botUserId: string;
	now?: () => Date;
	logger: Logger;
};

export const createMessageHandler =
	(deps: HandlerDeps) =>
	async (message: MessageLike, channel: ChannelLike): Promise<void> => {
		const log = deps.logger;
		const envelope = toEnvelope(message, {
			partnerId: deps.partnerId,
			botUserId: deps.botUserId,
			now: (deps.now ?? (() => new Date()))(),
		});
		if (!envelope.ok) {
			log.debug("message skipped", { message_id: message.id });
			return;
		}

		const typing = () =>
			channel.sendTyping().catch((e: unknown) => {
				log.debug("typing failed", { error: String(e) });
			});
		let interval: ReturnType<typeof setInterval> | undefined;
		const delay = setTimeout(() => {
			void typing();
			interval = setInterval(() => void typing(), TYPING_INTERVAL_MS);
		}, TYPING_DELAY_MS);
		let result: Awaited<ReturnType<YunomiClient["send"]>>;
		try {
			result = await deps.client.send(envelope.value);
		} finally {
			clearTimeout(delay);
			clearInterval(interval);
		}

		if (!result.ok) {
			log.error("yunomi request failed", {
				message_id: message.id,
				event_id: envelope.value.event_id,
				error: result.error.type,
			});
			return;
		}
		const response = result.value;
		if (response.action === "ignore") {
			log.info("ignored", { message_id: message.id });
			return;
		}
		let sent: { id: string };
		try {
			sent = await channel.send({
				content: response.content,
				reply: {
					messageReference: response.reply_to_message_id ?? message.id,
					failIfNotExists: false,
				},
				// @everyone やロール宛 ping を許さない。返信先ユーザーにも通知しない
				allowedMentions: { repliedUser: false, parse: [] },
			});
		} catch (e) {
			log.error("discord send failed", {
				message_id: message.id,
				error: e instanceof Error ? e.name : "unknown",
			});
			return;
		}
		log.info("replied", {
			message_id: message.id,
			length: response.content.length,
		});

		// 通知は best effort。失敗しても返信自体は済んでいる
		if (!response.partner_message_id) return;
		try {
			const notified = await deps.client.notifySent(deps.partnerId, {
				partner_message_id: response.partner_message_id,
				channel_id: message.channelId,
				discord_message_id: sent.id,
			});
			if (!notified.ok) {
				log.warn("sent notification failed", {
					message_id: message.id,
					sent_message_id: sent.id,
					error: notified.error.type,
				});
			} else if (!notified.value.bound) {
				// Worker 側で partner 発言が見つからなかった。Discord 上の返信を partner 宛てと判定できない
				log.warn("sent notification not bound", {
					message_id: message.id,
					sent_message_id: sent.id,
				});
			}
		} catch (e) {
			log.warn("sent notification failed", {
				message_id: message.id,
				sent_message_id: sent.id,
				error: e instanceof Error ? e.name : "unknown",
			});
		}
	};
