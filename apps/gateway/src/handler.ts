import type { Logger } from "./logger.ts";
import { type MessageLike, toEnvelope } from "./to-envelope.ts";
import type { YunomiClient } from "./yunomi-client.ts";

export const TYPING_INTERVAL_MS = 8000;

/** discord.js のテキストチャンネルのうち handler が使う部分。 */
export type ChannelLike = {
	sendTyping: () => Promise<unknown>;
	send: (options: {
		content: string;
		reply: { messageReference: string; failIfNotExists: boolean };
		allowedMentions: { repliedUser: boolean; parse: never[] };
	}) => Promise<unknown>;
};

export type HandlerDeps = {
	client: Pick<YunomiClient, "send">;
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
		void typing();
		const timer = setInterval(() => void typing(), TYPING_INTERVAL_MS);
		let result: Awaited<ReturnType<YunomiClient["send"]>>;
		try {
			result = await deps.client.send(envelope.value);
		} finally {
			clearInterval(timer);
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
		try {
			await channel.send({
				content: response.content,
				reply: {
					messageReference: response.reply_to_message_id ?? message.id,
					failIfNotExists: false,
				},
				// @everyone やロール宛 ping を許さない。返信先ユーザーにも通知しない
				allowedMentions: { repliedUser: false, parse: [] },
			});
			log.info("replied", {
				message_id: message.id,
				length: response.content.length,
			});
		} catch (e) {
			log.error("discord send failed", {
				message_id: message.id,
				error: e instanceof Error ? e.name : "unknown",
			});
		}
	};
