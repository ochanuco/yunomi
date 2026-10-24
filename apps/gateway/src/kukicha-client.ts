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
import * as v from "valibot";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
// 発話は最長 30 秒。文字にするのはそれより十分短く終わる
const TRANSCRIBE_TIMEOUT_MS = 30_000;
// 発話は時間が経つと返事の意味が薄れるので、器官が寝ている間を待ち続けない
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 1_000;
const LANGUAGE = "ja";

export type TranscribeRequest = {
	/** 16kHz mono 16bit の WAV */
	wav: Uint8Array;
	/** この人の声と判定した部分だけを文字にさせる。 */
	speaker: string;
};

export type Transcript = {
	/** 空なら、speaker の発話は無かった。 */
	text: string;
	durationMs: number;
};

export type KukichaClientOptions = {
	baseUrl: string;
	token: string;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	logger?: Logger;
};

export type KukichaClient = {
	/** 接続エラー・タイムアウト・5xx だけ 1 回やり直す。 */
	transcribe(
		request: TranscribeRequest,
	): Promise<Result<Transcript, DomainError>>;
};

const rpcSchema = v.object({
	result: v.optional(
		v.object({
			structuredContent: v.optional(
				v.looseObject({
					text: v.string(),
					duration_ms: v.optional(v.number()),
				}),
			),
			isError: v.optional(v.boolean()),
		}),
	),
	error: v.optional(v.looseObject({ message: v.string() })),
});

const httpError = (status: number): DomainError => {
	if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
		return permissionDenied({ actor: "gateway", action: "kukicha" });
	}
	if (status === 429) return rateLimited();
	if (status >= 500) return externalServiceUnavailable({ service: "kukicha" });
	return validationFailed({ issues: [`kukicha ${status}`] });
};

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

type Attempt =
	| { kind: "done"; result: Result<Transcript, DomainError> }
	| { kind: "retry"; error: DomainError; reason: string };

export const createKukichaClient = (
	opts: KukichaClientOptions,
): KukichaClient => {
	const doFetch = opts.fetch ?? fetch;
	const sleep = opts.sleep ?? defaultSleep;
	const log = opts.logger ?? silentLogger;
	const base = opts.baseUrl.replace(/\/+$/, "");

	const attempt = async (body: string): Promise<Attempt> => {
		let res: Response;
		try {
			res = await doFetch(`${base}/mcp`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${opts.token}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"mcp-protocol-version": MCP_PROTOCOL_VERSION,
				},
				redirect: "manual",
				signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
				body,
			});
		} catch (e) {
			return {
				kind: "retry",
				error: externalServiceUnavailable({ service: "kukicha" }),
				reason: e instanceof Error ? e.name : "network",
			};
		}
		if (res.status >= 500) {
			return {
				kind: "retry",
				error: httpError(res.status),
				reason: String(res.status),
			};
		}
		if (!res.ok) return { kind: "done", result: err(httpError(res.status)) };

		const json = await res.json().catch(() => null);
		const parsed = v.safeParse(rpcSchema, json);
		if (!parsed.success) {
			return {
				kind: "done",
				result: err(validationFailed({ issues: ["kukicha の応答を読めない"] })),
			};
		}
		const { result, error } = parsed.output;
		if (error || !result) {
			return {
				kind: "done",
				result: err(
					validationFailed({ issues: [error?.message ?? "kukicha error"] }),
				),
			};
		}
		if (result.isError) {
			return {
				kind: "done",
				result: err(externalServiceUnavailable({ service: "kukicha" })),
			};
		}
		if (!result.structuredContent) {
			return {
				kind: "done",
				result: err(validationFailed({ issues: ["kukicha に文字がない"] })),
			};
		}
		const { text, duration_ms } = result.structuredContent;
		return {
			kind: "done",
			result: ok({ text, durationMs: duration_ms ?? 0 }),
		};
	};

	return {
		async transcribe(request) {
			const body = JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "transcribe",
					arguments: {
						audio: Buffer.from(request.wav).toString("base64"),
						language: LANGUAGE,
						speaker: request.speaker,
					},
				},
			});
			let last: DomainError = externalServiceUnavailable({
				service: "kukicha",
			});
			for (let i = 1; i <= MAX_ATTEMPTS; i++) {
				const outcome = await attempt(body);
				if (outcome.kind === "done") return outcome.result;
				last = outcome.error;
				if (i === MAX_ATTEMPTS) break;
				log.debug("kukicha transcribe failed, retrying", {
					attempt: i,
					reason: outcome.reason,
				});
				await sleep(RETRY_BACKOFF_MS);
			}
			return err(last);
		},
	};
};
