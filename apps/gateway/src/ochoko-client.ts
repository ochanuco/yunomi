import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	permissionDenied,
	type Result,
	rateLimited,
	type SpeechRequest,
	type SpeechResult,
	validationFailed,
} from "@yunomi/core";
import * as v from "valibot";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
// ochoko は 1 回の合成を 50 秒以内に終える。その外側で切る。
const SYNTHESIZE_TIMEOUT_MS = 60_000;
const KEEP_AWAKE_TIMEOUT_MS = 10_000;
const MAX_TEXT_LENGTH = 2000;

export const SYNTHESIZE_DEADLINE_MS = 120_000;
export const SYNTHESIZE_BACKOFF_MS = 5_000;

export type OchokoClientOptions = {
	baseUrl: string;
	token: string;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	logger?: Logger;
};

export type OchokoClient = {
	/** 1 回だけ合成を試す。再試行は synthesizeWithRetry が担う。 */
	synthesize(
		request: SpeechRequest,
	): Promise<Result<SpeechResult, DomainError>>;
	keepAwake(input: {
		ttlSeconds: number;
		partnerId: string;
	}): Promise<Result<void, DomainError>>;
	synthesizeWithRetry(
		request: SpeechRequest,
	): Promise<Result<SpeechResult, DomainError>>;
};

const rpcSchema = v.object({
	result: v.optional(
		v.object({
			content: v.array(
				v.looseObject({
					type: v.string(),
					data: v.optional(v.string()),
					mimeType: v.optional(v.string()),
				}),
			),
			structuredContent: v.optional(
				v.looseObject({ duration_ms: v.optional(v.number()) }),
			),
			isError: v.optional(v.boolean()),
		}),
	),
	error: v.optional(v.looseObject({ message: v.string() })),
});

const httpError = (status: number): DomainError => {
	if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
		return permissionDenied({ actor: "gateway", action: "ochoko" });
	}
	if (status === 429) return rateLimited();
	if (status >= 500) return externalServiceUnavailable({ service: "ochoko" });
	return validationFailed({ issues: [`ochoko ${status}`] });
};

/** GPU 機が寝ている・起動中のとき（接続不可・タイムアウト・busy・5xx・429）だけ待てば直る。 */
const isRetryable = (e: DomainError): boolean => e.retryable;

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createOchokoClient = (opts: OchokoClientOptions): OchokoClient => {
	const doFetch = opts.fetch ?? fetch;
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? Date.now;
	const log = opts.logger ?? silentLogger;
	const base = opts.baseUrl.replace(/\/+$/, "");

	const callTool = async (
		name: string,
		args: Record<string, unknown>,
		timeoutMs: number,
	): Promise<
		Result<NonNullable<v.InferOutput<typeof rpcSchema>["result"]>, DomainError>
	> => {
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
				signal: AbortSignal.timeout(timeoutMs),
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: args },
				}),
			});
		} catch {
			return err(externalServiceUnavailable({ service: "ochoko" }));
		}
		if (!res.ok) return err(httpError(res.status));

		const body = await res.json().catch(() => null);
		const parsed = v.safeParse(rpcSchema, body);
		if (!parsed.success) {
			return err(validationFailed({ issues: ["ochoko の応答を読めない"] }));
		}
		const { result, error } = parsed.output;
		if (error || !result) {
			return err(
				validationFailed({ issues: [error?.message ?? "ochoko error"] }),
			);
		}
		// busy・タイムアウト・エンジンの失敗はツールのエラーとして返る。
		if (result.isError) {
			return err(externalServiceUnavailable({ service: "ochoko" }));
		}
		return ok(result);
	};

	const synthesize: OchokoClient["synthesize"] = async (request) => {
		if (request.text.length > MAX_TEXT_LENGTH) {
			return err(
				validationFailed({ issues: ["text が ochoko の上限を超えている"] }),
			);
		}
		const { preset, presetOverrides, masterOverrides } = request.values;
		const called = await callTool(
			"synthesize",
			{
				text: request.text,
				preset,
				preset_overrides: presetOverrides,
				master_overrides: masterOverrides,
			},
			SYNTHESIZE_TIMEOUT_MS,
		);
		if (!called.ok) return called;
		const result = called.value;
		const audio = result.content.find((c) => c.type === "audio");
		const bytes = audio?.data ? Buffer.from(audio.data, "base64") : null;
		if (!audio || !bytes || bytes.length === 0) {
			return err(validationFailed({ issues: ["ochoko に音声がない"] }));
		}
		return ok({
			audio: new Uint8Array(bytes),
			contentType: audio.mimeType ?? "audio/wav",
			durationMs: result.structuredContent?.duration_ms ?? 0,
		});
	};

	return {
		synthesize,

		async keepAwake({ ttlSeconds, partnerId }) {
			const called = await callTool(
				"keep_awake",
				{ ttl_seconds: ttlSeconds, partner_id: partnerId },
				KEEP_AWAKE_TIMEOUT_MS,
			);
			return called.ok ? ok(undefined) : called;
		},

		// Gateway は GPU 機を起こせない（wol は Worker 側）。起きるまで期限つきで待つ
		async synthesizeWithRetry(request) {
			const deadline = now() + SYNTHESIZE_DEADLINE_MS;
			for (let attempt = 1; ; attempt++) {
				const result = await synthesize(request);
				if (result.ok || !isRetryable(result.error)) return result;
				if (now() + SYNTHESIZE_BACKOFF_MS >= deadline) return result;
				log.debug("ochoko synthesize failed, retrying", {
					attempt,
					error: result.error.type,
				});
				await sleep(SYNTHESIZE_BACKOFF_MS);
			}
		},
	};
};
