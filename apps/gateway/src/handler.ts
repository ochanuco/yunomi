import type { AvatarStock } from "./avatar-stock.ts";
import { type ChannelLike, deliverResponse } from "./deliver.ts";
import type { Logger } from "./logger.ts";
import { type MessageLike, toEnvelope } from "./to-envelope.ts";
import type { VoiceManager } from "./voice-manager.ts";
import type { YunomiClient } from "./yunomi-client.ts";

export type HandlerDeps = {
	client: Pick<YunomiClient, "send" | "notifySent">;
	partnerId: string;
	botUserId: string;
	voice?: Pick<VoiceManager, "apply">;
	/** 未設定なら表情画像を貼らない。 */
	avatars?: Pick<AvatarStock, "pick">;
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
		await deliverResponse(deps, response, {
			channel,
			channelId: message.channelId,
			logFields: { message_id: message.id },
			replyTo: () => {
				if (response.action !== "reply") return null;
				const target = response.reply_to_message_id ?? message.id;
				// 直近の発言が宛先そのままなら普通のメッセージで送り、間に他の発言があるときだけ 1 件目を返信形式にする
				return channel.lastMessageId === target ? null : target;
			},
		});
	};
