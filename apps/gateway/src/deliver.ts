import {
	type AvatarDirective,
	type GatewayResponse,
	replyMessagesOf,
	type VoiceDirective,
} from "@yunomi/protocol";
import type { AvatarStock } from "./avatar-stock.ts";
import type { Logger } from "./logger.ts";
import type { VoiceManager } from "./voice-manager.ts";
import type { YunomiClient } from "./yunomi-client.ts";

/** discord.js のテキストチャンネルのうち返事の送信に使う部分。 */
export type ChannelLike = {
	lastMessageId?: string | null;
	send: (
		options:
			| {
					content: string;
					reply?: { messageReference: string; failIfNotExists: boolean };
					allowedMentions: { repliedUser: boolean; parse: never[] };
			  }
			| {
					files: { attachment: string; name: string }[];
					allowedMentions: { repliedUser: boolean; parse: never[] };
			  },
	) => Promise<{ id: string }>;
};

export type DeliverDeps = {
	client: Pick<YunomiClient, "notifySent">;
	partnerId: string;
	voice?: Pick<VoiceManager, "apply">;
	/** 未設定なら表情画像を貼らない。 */
	avatars?: Pick<AvatarStock, "pick">;
	logger: Logger;
};

export type DeliverTarget = {
	channel: ChannelLike;
	channelId: string;
	/** ログで何への返事かを示す。 */
	logFields: Record<string, unknown>;
	/** 1 件目を返信形式にする宛先。送る直前に読む。null なら普通のメッセージで送る。 */
	replyTo: () => string | null;
};

/** VC の操作が失敗しても、テキストの返信は止めないよう待たない。 */
export const applyVoice = (
	deps: Pick<DeliverDeps, "voice" | "logger">,
	directive: VoiceDirective | undefined,
	logFields: Record<string, unknown>,
): void => {
	void deps.voice?.apply(directive).catch((e: unknown) => {
		deps.logger.error("voice directive failed", {
			...logFields,
			error: e instanceof Error ? e.name : "unknown",
		});
	});
};

/** Worker の応答を実行する。VC の指示・返事の送信・表情画像。 */
export const deliverResponse = async (
	deps: DeliverDeps,
	response: GatewayResponse,
	{ channel, channelId, logFields, replyTo }: DeliverTarget,
): Promise<void> => {
	const log = deps.logger;
	// 表情画像は返事の添え物なので、送れなくても返事の扱いは変えない
	const postAvatar = async (avatar: AvatarDirective | undefined) => {
		if (!avatar || !deps.avatars) return;
		const image = deps.avatars.pick(avatar.emotion);
		if (!image) {
			log.debug("avatar not stocked", { emotion: avatar.emotion });
			return;
		}
		try {
			await channel.send({
				files: [{ attachment: image.path, name: image.name }],
				allowedMentions: { repliedUser: false, parse: [] },
			});
			log.info("avatar posted", {
				...logFields,
				emotion: avatar.emotion,
				image: image.name,
			});
		} catch (e) {
			log.warn("avatar send failed", {
				...logFields,
				error: e instanceof Error ? e.name : "unknown",
			});
		}
	};

	if (response.action === "ignore") {
		log.info("ignored", logFields);
		return;
	}
	applyVoice(deps, response.voice, logFields);
	// Worker が送信まで済ませている。Worker が REST で送る設定になる前は reply で返ってくる
	if (response.action === "ack") {
		log.info("acked", logFields);
		await postAvatar(response.avatar);
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
				channel_id: channelId,
				discord_message_id: sentId,
			});
			if (!notified.ok) {
				log.warn("sent notification failed", {
					...logFields,
					sent_message_id: sentId,
					error: notified.error.type,
				});
			} else if (!notified.value.bound) {
				// Worker 側で partner 発言が見つからなかった。Discord 上の返信を partner 宛てと判定できない
				log.warn("sent notification not bound", {
					...logFields,
					sent_message_id: sentId,
				});
			}
		} catch (e) {
			log.warn("sent notification failed", {
				...logFields,
				sent_message_id: sentId,
				error: e instanceof Error ? e.name : "unknown",
			});
		}
	};
	const target = replyTo();
	const messages = replyMessagesOf(response);
	for (const [i, m] of messages.entries()) {
		let sent: { id: string };
		try {
			sent = await channel.send({
				content: m.content,
				...(target === null || i > 0
					? {}
					: { reply: { messageReference: target, failIfNotExists: false } }),
				// @everyone やロール宛 ping を許さない。返信先ユーザーにも通知しない
				allowedMentions: { repliedUser: false, parse: [] },
			});
		} catch (e) {
			log.error("discord send failed", {
				...logFields,
				index: i,
				unsent: messages.length - i,
				error: e instanceof Error ? e.name : "unknown",
			});
			return;
		}
		log.info("replied", {
			...logFields,
			index: i,
			length: m.content.length,
		});
		await notify(m.partner_message_id, sent.id);
	}
	await postAvatar(response.avatar);
};
