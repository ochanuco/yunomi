import type { CommunicationPort, DomainError } from "@yunomi/core";

// 人が次のメッセージを打つくらいの間。長く待たせすぎないよう上限を置く。
export const MESSAGE_GAP_BASE_MS = 600;
export const MESSAGE_GAP_PER_CHAR_MS = 40;
export const MESSAGE_GAP_MAX_MS = 2500;
// 1 ターンが Gateway の待ち時間（60 秒）に近づかないよう、間の合計にも上限を置く。超えた分は間なしで送る。
export const MESSAGE_GAPS_TOTAL_MAX_MS = 8000;

// Discord の nonce は 25 文字まで。
const NONCE_MAX_LENGTH = 25;

/** 次のメッセージを送る前の間。文字数は書記素ではなくコードポイントで数える。 */
export const messageGapMs = (text: string): number =>
	Math.min(
		MESSAGE_GAP_BASE_MS + MESSAGE_GAP_PER_CHAR_MS * [...text].length,
		MESSAGE_GAP_MAX_MS,
	);

/**
 * 同じ入力を処理し直したときに同じ値になるよう、入力メッセージの id と番号だけから作る。
 * 長すぎるときは番号を残すため先頭を削る。
 */
export const messageNonce = (inboundMessageId: string, index: number): string =>
	`${inboundMessageId}:${index}`.slice(-NONCE_MAX_LENGTH);

export type OutgoingMessage = {
	text: string;
	replyToMessageId?: string;
	nonce: string;
};

export type SendMessagesResult = {
	/** 送れたメッセージの Discord id。先頭から順に送れた分だけ。 */
	sentIds: string[];
	/** 最後まで送れたか、途中で止めたか、送信に失敗したか。 */
	end:
		| { type: "done" }
		| { type: "stopped"; at: number }
		| { type: "failed"; at: number; error: DomainError };
};

export type SendMessagesDeps = {
	port: CommunicationPort;
	channelId: string;
	sleep: (ms: number) => Promise<void>;
	/** 1 件送れるたびに呼ぶ。記録を送信の直後にそろえるため。 */
	onSent: (index: number, messageId: string) => void;
	/** 2 件目以降を送る直前に呼ぶ。true なら、そのメッセージから先を送らない。 */
	stopBefore?: (index: number) => boolean;
};

/** メッセージを順に送る。2 件目以降の前は入力中を出して間を置く。失敗したら残りは送らない。 */
export const sendMessages = async (
	deps: SendMessagesDeps,
	messages: readonly OutgoingMessage[],
): Promise<SendMessagesResult> => {
	const sentIds: string[] = [];
	let gapBudget = MESSAGE_GAPS_TOTAL_MAX_MS;
	for (const [i, m] of messages.entries()) {
		if (i > 0) {
			const gap = Math.min(messageGapMs(m.text), gapBudget);
			if (gap > 0) {
				gapBudget -= gap;
				void deps.port.sendTyping({ channelId: deps.channelId }).then((r) => {
					if (!r.ok)
						console.warn(
							"discord typing failed",
							r.error.type,
							r.error.message,
						);
				});
				await deps.sleep(gap);
			}
			if (deps.stopBefore?.(i)) {
				return { sentIds, end: { type: "stopped", at: i } };
			}
		}
		const sent = await deps.port.sendText({
			channelId: deps.channelId,
			text: m.text,
			nonce: m.nonce,
			...(m.replyToMessageId ? { replyToMessageId: m.replyToMessageId } : {}),
		});
		if (!sent.ok) {
			return { sentIds, end: { type: "failed", at: i, error: sent.error } };
		}
		sentIds.push(sent.value.messageId);
		deps.onSent(i, sent.value.messageId);
	}
	return { sentIds, end: { type: "done" } };
};
