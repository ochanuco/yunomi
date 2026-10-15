import {
	type Availability,
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	permissionDenied,
	rateLimited,
	type SpeechPort,
	validationFailed,
} from "@yunomi/core";
import * as v from "valibot";
import { type AccessCredentials, accessHeaders } from "./access.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
// ochoko は 1 回の合成を 50 秒以内に終える。その外側で切る。
const SYNTHESIZE_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 3_000;
const MAX_TEXT_LENGTH = 2000;

export type OchokoDeps = {
	baseUrl: string;
	access: AccessCredentials;
	/** ochoko の Bearer token。 */
	token: string;
	fetch?: typeof fetch;
};

export type Ochoko = SpeechPort & {
	/** /healthz から可用性を読む。応答しないとき、Tunnel の 502 は unreachable。 */
	health(): Promise<Availability>;
};

const healthSchema = v.object({
	engine: v.picklist(["ready", "starting", "unavailable", "unhealthy"]),
});

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

const decodeBase64 = (data: string): Uint8Array | null => {
	try {
		return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
};

const httpError = (status: number): DomainError => {
	// redirect: "manual" なので、Access に弾かれたログイン画面への 3xx もここに来る。
	if (status === 401 || status === 403 || (status >= 300 && status < 400)) {
		return permissionDenied({ actor: "worker", action: "ochoko" });
	}
	if (status === 429) return rateLimited();
	if (status >= 500) return externalServiceUnavailable({ service: "ochoko" });
	return validationFailed({ issues: [`ochoko ${status}`] });
};

export const createOchoko = (deps: OchokoDeps): Ochoko => {
	const doFetch = deps.fetch ?? fetch;
	const base = deps.baseUrl.replace(/\/+$/, "");
	const access = accessHeaders(deps.access);

	return {
		async health() {
			try {
				const res = await doFetch(`${base}/healthz`, {
					headers: access,
					redirect: "manual",
					signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
				});
				if (!res.ok) return "unreachable";
				const parsed = v.safeParse(healthSchema, await res.json());
				if (!parsed.success) return "unavailable";
				return parsed.output.engine === "ready"
					? "ready"
					: parsed.output.engine === "starting"
						? "waking"
						: "unavailable";
			} catch {
				return "unreachable";
			}
		},

		async synthesize(request) {
			if (request.text.length > MAX_TEXT_LENGTH) {
				return err(
					validationFailed({ issues: ["text が ochoko の上限を超えている"] }),
				);
			}
			const { preset, presetOverrides, masterOverrides } = request.values;
			let res: Response;
			try {
				res = await doFetch(`${base}/mcp`, {
					method: "POST",
					headers: {
						...access,
						authorization: `Bearer ${deps.token}`,
						"content-type": "application/json",
						accept: "application/json, text/event-stream",
						"mcp-protocol-version": MCP_PROTOCOL_VERSION,
					},
					redirect: "manual",
					signal: AbortSignal.timeout(SYNTHESIZE_TIMEOUT_MS),
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "tools/call",
						params: {
							name: "synthesize",
							arguments: {
								text: request.text,
								preset,
								preset_overrides: presetOverrides,
								master_overrides: masterOverrides,
							},
						},
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
			const audio = result.content.find((c) => c.type === "audio");
			const bytes = audio?.data ? decodeBase64(audio.data) : null;
			if (!audio || !bytes) {
				return err(validationFailed({ issues: ["ochoko に音声がない"] }));
			}
			return ok({
				audio: bytes,
				contentType: audio.mimeType ?? "audio/wav",
				durationMs: result.structuredContent?.duration_ms ?? 0,
			});
		},
	};
};
