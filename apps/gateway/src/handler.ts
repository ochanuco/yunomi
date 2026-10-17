import { replyMessagesOf, type VoiceDirective } from "@yunomi/protocol";
import type { Logger } from "./logger.ts";
import { type MessageLike, toEnvelope } from "./to-envelope.ts";
import type { VoiceManager } from "./voice-manager.ts";
import type { YunomiClient } from "./yunomi-client.ts";

/** discord.js のテキストチャンネルのうち handler が使う部分。 */
export type ChannelLike = {
	lastMessageId?: string | null;
	send: (options: {
		content: string;
		reply?: { messageReference: string; failIfNotExists: boolean };
		allowedMentions: { repliedUser: boolean; parse: never[] };
	}) => Promise<{ id: string }>;
};

export type HandlerDeps = {
	client: Pick<YunomiClient, "send" | "notifySent">;
	partnerId: string;
	botUserId: string;
	voice?: Pick<VoiceManager, "apply">;
	now?: () => Date;
	logger: Logger;
};

export const createMessageHandler =
	(deps: HandlerDeps) =>
	async (message: MessageLike, channel: ChannelLike): Promise<void> => {
		const log = deps.logger;
		// VC の操作が失敗しても、テキストの返信は止めない
		const applyVoice = (directive: VoiceDirective | undefined) => {
			void deps.voice?.apply(directive).catch((e: unknown) => {
				log.error("voice directive failed", {
					message_id: message.id,
					error: e instanceof Error ? e.name : "unknown",
				});
			});
		};
		const envelope = toEnvelope(message, {
			partnerId: deps.partnerId,
			botUserId: deps.botUserId,
			now: (deps.now ?? (() => new Date()))(),
		});
		if (!envelope.ok) {
			log.debug("message skipped", { message_id: message.id });
			return;
		}

		const result = await deps.client.send(envelope.value);

		if (!result.ok) {
			log.error("yunomi request failed", {
				message_id: message.id,
				event_id: envelope.value.event_id,
				error: result.error.type,
			});
			return;
		}
		const response = result.value;
		if (response.action !== "ignore") applyVoice(response.voice);
		if (response.action === "ignore") {
			log.info("ignored", { message_id: message.id });
			return;
		}
		// Worker が送信まで済ませている。Worker が REST で送る設定になる前は reply で返ってくる
		if (response.action === "ack") {
			log.info("acked", { message_id: message.id });
			return;
		}
		// 通知は best effort。失敗しても返信自体は済んでいる
		const notify = async (
			partnerMessageId: string | undefined,
			sentId: string,
		): Promise<void> => {
			if (!partnerMessageId) return;
			try {
				const notified = await deps.client.notifySent(deps.partnerId, {
					partner_message_id: partnerMessageId,
					channel_id: message.channelId,
					discord_message_id: sentId,
				});
				if (!notified.ok) {
					log.warn("sent notification failed", {
						message_id: message.id,
						sent_message_id: sentId,
						error: notified.error.type,
					});
				} else if (!notified.value.bound) {
					// Worker 側で partner 発言が見つからなかった。Discord 上の返信を partner 宛てと判定できない
					log.warn("sent notification not bound", {
						message_id: message.id,
						sent_message_id: sentId,
					});
				}
			} catch (e) {
				log.warn("sent notification failed", {
					message_id: message.id,
					sent_message_id: sentId,
					error: e instanceof Error ? e.name : "unknown",
				});
			}
		};
		const target = response.reply_to_message_id ?? message.id;
		// 直近の発言が宛先そのままなら普通のメッセージで送り、間に他の発言があるときだけ 1 件目を返信形式にする
		const quiet = channel.lastMessageId === target;
		const messages = replyMessagesOf(response);
		for (const [i, m] of messages.entries()) {
			let sent: { id: string };
			try {
				sent = await channel.send({
					content: m.content,
					...(quiet || i > 0
						? {}
						: { reply: { messageReference: target, failIfNotExists: false } }),
					// @everyone やロール宛 ping を許さない。返信先ユーザーにも通知しない
					allowedMentions: { repliedUser: false, parse: [] },
				});
			} catch (e) {
				log.error("discord send failed", {
					message_id: message.id,
					index: i,
					unsent: messages.length - i,
					error: e instanceof Error ? e.name : "unknown",
				});
				return;
			}
			log.info("replied", {
				message_id: message.id,
				index: i,
				length: m.content.length,
			});
			await notify(m.partner_message_id, sent.id);
		}
	};
