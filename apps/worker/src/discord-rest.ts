import {
	type CommunicationPort,
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	permissionDenied,
	type Result,
	rateLimited,
	type SentMessage,
	validationFailed,
} from "@yunomi/core";
import * as v from "valibot";

const API_BASE = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/ochanuco/yunomi, 0)";
const MAX_RETRIES = 2;
// これを超える待ちは、応答を保持したまま待たずに RateLimited として返す。
const MAX_RETRY_WAIT_MS = 5000;

export type DiscordRestDeps = {
	token: string;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
};

const MAX_DETAIL_LENGTH = 200;

const DiscordErrorBody = v.object({
	code: v.optional(v.number()),
	message: v.optional(v.string()),
});

// Discord のエラー本文から code と message を取り出して「403 code=50013 Missing Permissions」の形にする。
// 本文が JSON でなくても status だけで返す。
const errorDetail = async (res: Response): Promise<string> => {
	const raw = await res.json().catch(() => null);
	const parsed = v.safeParse(DiscordErrorBody, raw);
	const parts = [String(res.status)];
	if (parsed.success) {
		if (parsed.output.code !== undefined)
			parts.push(`code=${parsed.output.code}`);
		if (parsed.output.message)
			parts.push(parsed.output.message.slice(0, MAX_DETAIL_LENGTH));
	}
	return parts.join(" ");
};

const retryAfterMs = async (res: Response): Promise<number | null> => {
	const body = (await res.json().catch(() => null)) as {
		retry_after?: unknown;
	} | null;
	const seconds =
		typeof body?.retry_after === "number"
			? body.retry_after
			: Number(res.headers.get("retry-after"));
	return Number.isFinite(seconds) && seconds >= 0
		? Math.ceil(seconds * 1000)
		: null;
};

/** Discord REST で CommunicationPort を実装する。@everyone・ロール宛の ping と返信先への通知は常に止める。 */
export const createDiscordRest = (deps: DiscordRestDeps): CommunicationPort => {
	const doFetch = deps.fetch ?? fetch;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	// multipart の FormData は送ると消費されるため、試行ごとに build し直す。
	const request = async (
		path: string,
		build: () => { body: BodyInit; contentType?: string } | null,
	): Promise<Result<Response, DomainError>> => {
		for (let attempt = 0; ; attempt++) {
			const payload = build();
			let res: Response;
			try {
				res = await doFetch(`${API_BASE}${path}`, {
					method: "POST",
					headers: {
						authorization: `Bot ${deps.token}`,
						"user-agent": USER_AGENT,
						...(payload?.contentType
							? { "content-type": payload.contentType }
							: {}),
					},
					...(payload ? { body: payload.body } : {}),
				});
			} catch {
				return err(externalServiceUnavailable({ service: "discord" }));
			}
			if (res.ok) return ok(res);
			if (res.status === 429) {
				const wait = await retryAfterMs(res);
				if (
					wait === null ||
					wait > MAX_RETRY_WAIT_MS ||
					attempt >= MAX_RETRIES
				) {
					return err(rateLimited({ retryAfterMs: wait }));
				}
				await sleep(wait);
				continue;
			}
			const detail = await errorDetail(res);
			if (res.status === 401 || res.status === 403) {
				return err(
					permissionDenied({
						actor: "worker",
						action: `discord (${detail})`,
					}),
				);
			}
			if (res.status >= 500) {
				return err(
					externalServiceUnavailable({ service: `discord (${detail})` }),
				);
			}
			return err(validationFailed({ issues: [`discord ${detail}`] }));
		}
	};

	const sent = async (
		res: Response,
	): Promise<Result<SentMessage, DomainError>> => {
		const body = (await res.json().catch(() => null)) as {
			id?: unknown;
		} | null;
		return typeof body?.id === "string" && body.id !== ""
			? ok({ messageId: body.id })
			: err(validationFailed({ issues: ["discord response has no id"] }));
	};

	const reference = (replyToMessageId: string) => ({
		message_reference: {
			message_id: replyToMessageId,
			fail_if_not_exists: false,
		},
	});
	const allowedMentions = { parse: [], replied_user: false };

	return {
		async sendText(input) {
			const res = await request(
				`/channels/${input.channelId}/messages`,
				() => ({
					contentType: "application/json",
					body: JSON.stringify({
						content: input.text,
						allowed_mentions: allowedMentions,
						...(input.replyToMessageId
							? reference(input.replyToMessageId)
							: {}),
						// 再送で同じ nonce が来たら、Discord は新しく作らず先に作ったメッセージを返す。
						...(input.nonce ? { nonce: input.nonce, enforce_nonce: true } : {}),
					}),
				}),
			);
			return res.ok ? sent(res.value) : res;
		},

		async sendTyping(input) {
			const res = await request(
				`/channels/${input.channelId}/typing`,
				() => null,
			);
			return res.ok ? ok(undefined) : res;
		},

		async sendAttachment(input) {
			const res = await request(`/channels/${input.channelId}/messages`, () => {
				const form = new FormData();
				form.append(
					"payload_json",
					JSON.stringify({
						allowed_mentions: allowedMentions,
						...(input.replyToMessageId
							? reference(input.replyToMessageId)
							: {}),
						attachments: [{ id: 0, filename: input.filename }],
					}),
				);
				form.append(
					"files[0]",
					new Blob([input.data], { type: input.contentType }),
					input.filename,
				);
				return { body: form };
			});
			return res.ok ? sent(res.value) : res;
		},
	};
};
