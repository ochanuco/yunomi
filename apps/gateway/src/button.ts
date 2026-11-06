import type { DomainError } from "@yunomi/core";
import { err, newId, ok, type Result, validationFailed } from "@yunomi/core";
import {
	DISCORD_BUTTON_PRESSED,
	DISCORD_SOURCE,
	type DiscordButtonPressedEnvelope,
	discordButtonPressedEnvelopeSchema,
} from "@yunomi/protocol";
import * as v from "valibot";
import type { Logger } from "./logger.ts";
import type { WorkingClient } from "./working-client.ts";

/** discord.js の ButtonInteraction のうち Gateway が読む部分だけの構造型。 */
export type ButtonLike = {
	guildId: string;
	channelId: string;
	messageId: string;
	customId: string;
	createdAt: Date;
	user: { id: string; bot: boolean; displayName: string };
	/** ボタンが付いたメッセージのチャンネルのカテゴリ。スレッドなら親チャンネルのカテゴリ。 */
	categoryId: string | null;
};

export const toButtonEnvelope = (
	button: ButtonLike,
	{ partnerId, now }: { partnerId: string; now: Date },
): Result<DiscordButtonPressedEnvelope, DomainError> => {
	const candidate = {
		event_id: newId(),
		type: DISCORD_BUTTON_PRESSED,
		source: DISCORD_SOURCE,
		partner_id: partnerId,
		occurred_at: button.createdAt.toISOString(),
		received_at: now.toISOString(),
		schema_version: 1,
		payload: {
			guild_id: button.guildId,
			channel_id: button.channelId,
			message_id: button.messageId,
			custom_id: button.customId,
			user: {
				id: button.user.id,
				display_name: button.user.displayName,
				is_bot: button.user.bot,
			},
		},
	};
	const parsed = v.safeParse(discordButtonPressedEnvelopeSchema, candidate);
	if (!parsed.success) {
		return err(
			validationFailed({ issues: parsed.issues.map((i) => i.message) }),
		);
	}
	return ok(candidate as DiscordButtonPressedEnvelope);
};

export type ButtonHandlerDeps = {
	partnerId: string;
	workCategoryIds: ReadonlySet<string>;
	/** 未設定なら仕事カテゴリのボタンも受けない。 */
	working: Pick<WorkingClient, "forward"> | null;
	now?: () => Date;
	logger: Logger;
};

/**
 * 仕事カテゴリで押されたボタンを Working へ渡す。
 * ボタンはメッセージを書いた bot の Gateway にだけ届くので、発言と違って WORKING_FORWARD によらず渡す。
 * Discord は 3 秒以内の応答を求めるので、Working の処理を待たずに ack で受け取ったことだけを返す。
 * 押した人が持ち主かどうかは Working が決める。
 */
export const createButtonHandler =
	(deps: ButtonHandlerDeps) =>
	async (button: ButtonLike, ack: () => Promise<unknown>): Promise<void> => {
		const log = deps.logger;
		if (
			!deps.working ||
			button.categoryId === null ||
			!deps.workCategoryIds.has(button.categoryId)
		) {
			return;
		}
		await ack().catch((e: unknown) => {
			log.warn("button ack failed", {
				message_id: button.messageId,
				error: String(e),
			});
		});
		const envelope = toButtonEnvelope(button, {
			partnerId: deps.partnerId,
			now: (deps.now ?? (() => new Date()))(),
		});
		if (!envelope.ok) {
			log.warn("button skipped", { message_id: button.messageId });
			return;
		}
		const forwarded = await deps.working.forward(envelope.value);
		if (!forwarded.ok) {
			log.warn("working forward failed", {
				message_id: button.messageId,
				event_id: envelope.value.event_id,
				error: forwarded.error.type,
			});
		}
	};
