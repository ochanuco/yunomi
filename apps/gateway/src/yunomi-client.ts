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
import {
	type DiscordMessageCreatedEnvelope,
	type DiscordSent,
	discordSentPathFor,
	type GatewayResponse,
	gatewayResponseSchema,
} from "@yunomi/protocol";
import * as v from "valibot";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";

export const EVENTS_PATH = "/v1/interfaces/discord/events";
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];
const MAX_RETRY_AFTER_MS = 30_000;

export type YunomiClientOptions = {
	baseUrl: string;
	access: { clientId: string; clientSecret: string } | null;
	devCaller: boolean;
	timeoutMs?: number;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	logger?: Logger;
};

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

const parseRetryAfter = (value: string | null): number | null => {
	if (!value) return null;
	const sec = Number(value);
	if (Number.isFinite(sec) && sec >= 0) return sec * 1000;
	const at = Date.parse(value);
	return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
};

export class YunomiClient {
	readonly #baseUrl: string;
	readonly #url: string;
	readonly #headers: Record<string, string>;
	readonly #timeoutMs: number;
	readonly #fetch: typeof fetch;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #log: Logger;

	constructor(opts: YunomiClientOptions) {
		this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
		this.#url = `${this.#baseUrl}${EVENTS_PATH}`;
		this.#headers = { "content-type": "application/json" };
		if (opts.access) {
			this.#headers["CF-Access-Client-Id"] = opts.access.clientId;
			this.#headers["CF-Access-Client-Secret"] = opts.access.clientSecret;
		} else if (opts.devCaller) {
			this.#headers["x-yunomi-dev-caller"] = "gateway";
		}
		this.#timeoutMs = opts.timeoutMs ?? 60_000;
		this.#fetch = opts.fetch ?? fetch;
		this.#sleep = opts.sleep ?? defaultSleep;
		this.#log = opts.logger ?? silentLogger;
	}

	async send(
		envelope: DiscordMessageCreatedEnvelope,
	): Promise<Result<GatewayResponse, DomainError>> {
		return this.#withRetry(
			this.#url,
			JSON.stringify(envelope),
			envelope.event_id,
			"POST events",
			(json) => v.safeParse(gatewayResponseSchema, json),
		);
	}

	/** reply の送信後に、partner 発言の Discord message id を Worker へ知らせる。 */
	async notifySent(
		partnerId: string,
		sent: DiscordSent,
	): Promise<Result<{ bound: boolean }, DomainError>> {
		return this.#withRetry(
			`${this.#baseUrl}${discordSentPathFor(partnerId)}`,
			JSON.stringify(sent),
			sent.discord_message_id,
			"POST sent",
			(json) => v.safeParse(v.object({ bound: v.boolean() }), json),
		);
	}

	async #withRetry<T>(
		url: string,
		body: string,
		logId: string,
		action: string,
		parse: (json: unknown) => v.SafeParseResult<v.GenericSchema<unknown, T>>,
	): Promise<Result<T, DomainError>> {
		let last: DomainError = externalServiceUnavailable({ service: "yunomi" });
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			const outcome = await this.#attempt(url, body, action, parse);
			if (outcome.kind === "done") return outcome.result;
			last = outcome.error;
			if (attempt === MAX_ATTEMPTS - 1) break;
			const wait = Math.min(
				outcome.retryAfterMs ?? BACKOFF_MS[attempt] ?? 4000,
				MAX_RETRY_AFTER_MS,
			);
			this.#log.warn("yunomi request failed, retrying", {
				id: logId,
				attempt: attempt + 1,
				reason: outcome.reason,
				wait_ms: wait,
			});
			await this.#sleep(wait);
		}
		return err(last);
	}

	async #attempt<T>(
		url: string,
		body: string,
		action: string,
		parse: (json: unknown) => v.SafeParseResult<v.GenericSchema<unknown, T>>,
	): Promise<
		| { kind: "done"; result: Result<T, DomainError> }
		| {
				kind: "retry";
				error: DomainError;
				reason: string;
				retryAfterMs: number | null;
		  }
	> {
		let res: Response;
		try {
			res = await this.#fetch(url, {
				method: "POST",
				headers: this.#headers,
				body,
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch (e) {
			return {
				kind: "retry",
				error: externalServiceUnavailable({ service: "yunomi" }),
				reason: e instanceof Error ? e.name : "network",
				retryAfterMs: null,
			};
		}
		if (res.status === 429) {
			const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
			return {
				kind: "retry",
				error: rateLimited({ retryAfterMs }),
				reason: "429",
				retryAfterMs,
			};
		}
		if (res.status >= 500) {
			return {
				kind: "retry",
				error: externalServiceUnavailable({ service: "yunomi" }),
				reason: String(res.status),
				retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
			};
		}
		if (res.status === 401 || res.status === 403) {
			return {
				kind: "done",
				result: err(permissionDenied({ actor: "gateway", action })),
			};
		}
		if (!res.ok) {
			return {
				kind: "done",
				result: err(validationFailed({ issues: [`HTTP ${res.status}`] })),
			};
		}
		let json: unknown;
		try {
			json = await res.json();
		} catch {
			return {
				kind: "done",
				result: err(validationFailed({ issues: ["レスポンスが JSON でない"] })),
			};
		}
		const parsed = parse(json);
		if (!parsed.success) {
			return {
				kind: "done",
				result: err(
					validationFailed({
						issues: parsed.issues.map((i) => v.getDotPath(i) ?? i.message),
					}),
				),
			};
		}
		return { kind: "done", result: ok(parsed.output) };
	}
}
