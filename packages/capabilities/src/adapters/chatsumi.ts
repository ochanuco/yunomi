import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
	rateLimited,
	toolExecutionRejected,
	validationFailed,
} from "@yunomi/core";
import * as v from "valibot";
import type { CapabilityAdapter, CapabilityResponse } from "../contract.ts";
import { type WebFetchInput, webFetch } from "../definitions/web.ts";
import { parseToolInput } from "../input.ts";

const SERVICE = "chatsumi";
// モデルに渡す本文の長さ。chatsumi は既定で 20,000 文字まで返すが、会話の文脈には多すぎる。
const MAX_TEXT_CHARS = 4_000;
// chatsumi は http の取得（最大 20 秒）で弾かれると browser（最大 30 秒）でやり直すため、最悪で 50 秒かかる。
// ただし道具のループ全体の上限が 45 秒なので、それに合わせて切る。
const DEFAULT_TIMEOUT_MS = 45_000;

export type ChatsumiDeps = {
	fetch: typeof fetch;
	/** chatsumi の origin（例 `https://chatsumi.chanu.co`）。 */
	baseUrl: string;
	/** Cloudflare Access のサービストークン。 */
	accessClientId: string;
	accessClientSecret: string;
	/** chatsumi への fetch の待ち時間の上限（ms）。既定は 45 秒。 */
	timeoutMs?: number;
};

const FetchTextResponse = v.variant("ok", [
	v.object({
		ok: v.literal(true),
		title: v.optional(v.nullable(v.string())),
		text: v.string(),
		truncated: v.optional(v.boolean(), false),
		finalUrl: v.string(),
		mode: v.picklist(["http", "browser"]),
	}),
	v.object({
		ok: v.literal(false),
		error: v.object({
			type: v.string(),
			message: v.optional(v.string()),
		}),
	}),
]);

// externalServiceUnavailable は retryable: true で作られる。直らない失敗は retryable を下げる。
const unavailable = (detail: string, retryable = true): DomainError => {
	const base = externalServiceUnavailable({ service: SERVICE });
	return { ...base, retryable, message: `${base.message}: ${detail}` };
};

// 再試行で直るのは一時的な失敗だけ。challenge や forbidden は browser でも弾かれた結果なので直らない。
const RETRYABLE_FETCH_ERRORS: ReadonlySet<string> = new Set([
	"upstream_error",
	"timeout",
	"network_error",
	"browser_unavailable",
]);

// chatsumi の取得の失敗（HTTP 200 の ok: false）を道具の失敗にする。
// gate がモデルに返すのは型名と retryable だけなので、モデルが言い分けたい失敗は型を分ける。
// 内部アドレスへの要求は拒否（ToolExecutionRejected）、取得先の制限は RateLimited、
// それ以外は ExternalServiceUnavailable にして、細かい type は message に残す。
const fetchFailure = (
	type: string,
	message: string | undefined,
): DomainError => {
	switch (type) {
		case "ssrf_blocked":
			return toolExecutionRejected({
				tool: webFetch.name,
				reason: "ssrf_blocked: 内部や非公開のアドレスは読めない",
			});
		case "rate_limited":
			return rateLimited({ retryAfterMs: null });
		default:
			return unavailable(
				`ページを取得できなかった (${type}${message ? `: ${message}` : ""})`,
				RETRYABLE_FETCH_ERRORS.has(type),
			);
	}
};

const truncate = (text: string): { text: string; truncated: boolean } => {
	const chars = Array.from(text);
	return chars.length <= MAX_TEXT_CHARS
		? { text, truncated: false }
		: { text: chars.slice(0, MAX_TEXT_CHARS).join(""), truncated: true };
};

/**
 * chatsumi（`POST /fetchText`）の adapter。URL のページのタイトルと本文を読むだけで、状態を持たない。
 * summary にはホスト名と使った mode だけを書き、パスやクエリ、本文は入れない（URL に含まれる情報を Audit に残さない）。
 */
export const createChatsumiAdapter = (
	deps: ChatsumiDeps,
): CapabilityAdapter => {
	// Workers の fetch は this が globalThis でないと Illegal invocation になるため、プロパティ越しに呼ばない。
	const doFetch = deps.fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const endpoint = `${deps.baseUrl.replace(/\/+$/, "")}/fetchText`;

	const httpFailure = (res: Response): DomainError => {
		if (res.status === 429) return rateLimited({ retryAfterMs: null });
		// Access が弾いたときは chatsumi に届いていない。サービストークンの失効や設定の誤りで、再試行しても直らない。
		if (res.status === 401 || res.status === 403) {
			return unavailable(
				`chatsumi の認証に失敗した (${res.status})。Access のサービストークンを確認する`,
				false,
			);
		}
		return unavailable(`chatsumi が ${res.status} を返した`, res.status >= 500);
	};

	const read = async (
		input: WebFetchInput,
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
				body: JSON.stringify({ url: input.url }),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (e) {
			const timedOut = e instanceof Error && e.name === "TimeoutError";
			return err(
				unavailable(
					timedOut
						? "chatsumi の応答がタイムアウトした"
						: "chatsumi に接続できない",
				),
			);
		}
		// 400 は入力の誤りとして body に type が入るが、入力は送る前に検証済みなので、ほかの非 2xx と同じに扱う。
		if (!res.ok) return err(httpFailure(res));
		const parsed = v.safeParse(
			FetchTextResponse,
			await res.json().catch(() => null),
		);
		if (!parsed.success) {
			const issue = parsed.issues[0];
			const path = issue === undefined ? null : v.getDotPath(issue);
			return err(
				unavailable(`chatsumi の応答が想定と違う (${path ?? "応答全体"})`),
			);
		}

		const out = parsed.output;
		if (!out.ok) return err(fetchFailure(out.error.type, out.error.message));
		const body = truncate(out.text);
		return ok({
			data: {
				title: out.title ?? null,
				text: body.text,
				text_truncated: body.truncated || out.truncated,
				final_url: out.finalUrl,
				mode: out.mode,
			},
			summary: `${new URL(input.url).hostname} を ${out.mode} で取得`,
		});
	};

	return {
		tools: [webFetch],
		async execute(request) {
			if (request.tool !== webFetch.name) {
				return err(
					validationFailed({ issues: [`未知の道具: ${request.tool}`] }),
				);
			}
			const input = parseToolInput(webFetch, request.input);
			return input.ok ? read(input.value) : input;
		},
	};
};
