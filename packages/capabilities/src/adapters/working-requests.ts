import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	permissionDenied,
	type Result,
	rateLimited,
	validationFailed,
} from "@yunomi/core";
import type {
	CallContext,
	CapabilityAdapter,
	CapabilityResponse,
} from "../contract.ts";
import { type WorkRequestInput, workRequest } from "../definitions/work.ts";
import { parseToolInput } from "../input.ts";

const SERVICE = "mizuya";
// mizuya は受け箱に積むだけで待たずに 202 を返す。
const DEFAULT_TIMEOUT_MS = 10_000;

export type WorkingRequestsDeps = {
	fetch: typeof fetch;
	/** mizuya の Worker の origin（例 `https://mizuya.chanu.co`）。 */
	baseUrl: string;
	/** Cloudflare Access のサービストークン。 */
	accessClientId: string;
	accessClientSecret: string;
	timeoutMs?: number;
};

const SNOWFLAKE = /^\d+$/;

/** 依頼のもとになった Discord の発言へのリンク。VC の発話など、Discord の発言でなければ null。 */
export const discordMessageUrl = (
	ctx: Pick<CallContext, "guildId" | "channelId" | "sourceMessageId">,
): string | null =>
	ctx.guildId !== undefined &&
	SNOWFLAKE.test(ctx.guildId) &&
	SNOWFLAKE.test(ctx.channelId) &&
	SNOWFLAKE.test(ctx.sourceMessageId)
		? `https://discord.com/channels/${ctx.guildId}/${ctx.channelId}/${ctx.sourceMessageId}`
		: null;

const unavailable = (detail: string, retryable: boolean): DomainError => {
	const base = externalServiceUnavailable({ service: SERVICE });
	return { ...base, retryable, message: `${base.message}: ${detail}` };
};

// gate がモデルに返すのは失敗の型名と retryable だけなので、オーナーへの説明が変わる失敗は型を分ける。
const httpFailure = (status: number): DomainError => {
	if (status === 400) {
		return validationFailed({
			issues: ["mizuya が依頼の形を受け付けなかった"],
		});
	}
	// Access か mizuya が弾いた。サービストークンの失効や設定の誤りで、再試行しても直らない。
	if (status === 401 || status === 403) {
		return permissionDenied({ actor: "yunomi", action: "working_request" });
	}
	if (status === 429) return rateLimited({ retryAfterMs: null });
	return unavailable(`mizuya が ${status} を返した`, status >= 500);
};

/**
 * 仕事の依頼を mizuya の受け箱（`POST /working/requests`）に渡す。結果は待たず、席の出来事として後で届く。
 * summary に件名や本文は入れない（Audit に会話の中身を残さない）。
 */
export const createWorkingRequestsAdapter = (
	deps: WorkingRequestsDeps,
): CapabilityAdapter => {
	// Workers の fetch は this が globalThis でないと Illegal invocation になるため、プロパティ越しに呼ばない。
	const doFetch = deps.fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const endpoint = `${deps.baseUrl.replace(/\/+$/, "")}/working/requests`;

	const send = async (
		requestId: string,
		input: WorkRequestInput,
		ctx: CallContext,
	): Promise<Result<CapabilityResponse, DomainError>> => {
		let res: Response;
		try {
			res = await doFetch(endpoint, {
				method: "POST",
				headers: {
					"CF-Access-Client-Id": deps.accessClientId,
					"CF-Access-Client-Secret": deps.accessClientSecret,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					request_id: requestId,
					partner: ctx.partnerId,
					title: input.title,
					request: input.request,
					requested_by: ctx.speakerId,
					context_url: discordMessageUrl(ctx),
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (e) {
			const timedOut = e instanceof Error && e.name === "TimeoutError";
			return err(
				unavailable(
					timedOut
						? "mizuya の応答がタイムアウトした"
						: "mizuya に接続できない",
					true,
				),
			);
		}
		if (!res.ok) return err(httpFailure(res.status));
		return ok({
			data: {
				status: "accepted",
				note: "仕事の席に渡した。結果はこの会話では待たず、あとで「今の仕事」に出る。",
			},
			summary: "仕事を 1 件渡した",
		});
	};

	return {
		tools: [workRequest],
		async execute(request) {
			if (request.tool !== workRequest.name) {
				return err(
					validationFailed({ issues: [`未知の道具: ${request.tool}`] }),
				);
			}
			const input = parseToolInput(workRequest, request.input);
			return input.ok
				? send(request.requestId, input.value, request.context)
				: input;
		},
	};
};
