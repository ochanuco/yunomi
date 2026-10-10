import Anthropic from "@anthropic-ai/sdk";
import {
	type DomainError,
	err,
	ok,
	type Result,
	validationFailed,
} from "@yunomi/core";
import * as v from "valibot";
import { mapSdkError, refusalError } from "./errors.ts";
import {
	type Effort,
	type LLMProvider,
	type LLMRequest,
	type LLMResult,
	SONNET,
} from "./types.ts";

export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type ClaudeProviderOptions = {
	apiKey: string;
	baseURL?: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
	/** 会話ターンの既定。 */
	effort?: Effort;
};

type ResponseLike = {
	model: string;
	stop_reason: string | null;
	content: { type: string; text?: string }[];
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number | null;
		cache_creation_input_tokens?: number | null;
	};
};

export class ClaudeProvider implements LLMProvider {
	readonly #client: Anthropic;
	readonly #effort: Effort;

	constructor(opts: ClaudeProviderOptions) {
		// retry は ModelRouter が持つので SDK 側は 0 にする。
		this.#client = new Anthropic({
			apiKey: opts.apiKey,
			baseURL: opts.baseURL,
			fetch: opts.fetch,
			maxRetries: 0,
			timeout: opts.timeoutMs ?? 25_000,
		});
		this.#effort = opts.effort ?? "low";
	}

	async generate<T>(
		req: LLMRequest<T>,
	): Promise<Result<LLMResult<T>, DomainError>> {
		const started = Date.now();
		let res: ResponseLike;
		try {
			res = await this.#call(req);
		} catch (e) {
			return err(mapSdkError(e));
		}
		if (res.stop_reason === "refusal") return err(refusalError());

		// fallback 発生時、拒否したモデルの途中出力が前に残るため最後の fallback 以降だけを読む。
		const blocks = res.content;
		const lastFallback = blocks.map((b) => b.type).lastIndexOf("fallback");
		const text = blocks
			.slice(lastFallback + 1)
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("");

		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return err(
				validationFailed({ issues: ["応答が JSON として解釈できない"] }),
			);
		}
		const parsed = v.safeParse(req.output.schema, json);
		if (!parsed.success) {
			return err(
				validationFailed({
					issues: parsed.issues.map((i) => {
						const path = v.getDotPath(i);
						return path ? `${path}: ${i.message}` : i.message;
					}),
				}),
			);
		}
		return ok({
			output: parsed.output,
			model: res.model,
			usage: {
				inputTokens: res.usage.input_tokens,
				outputTokens: res.usage.output_tokens,
				cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
				cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
			},
			latencyMs: Date.now() - started,
			stopReason: res.stop_reason,
		});
	}

	#call<T>(req: LLMRequest<T>): Promise<ResponseLike> {
		const base = {
			model: req.model,
			max_tokens: req.maxTokens,
			system: req.system.map((b) => ({
				type: "text" as const,
				text: b.text,
				...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
			})),
			messages: req.messages,
			output_config: {
				effort: req.effort ?? this.#effort,
				format: {
					type: "json_schema" as const,
					schema: req.output.jsonSchema,
				},
			},
		};
		if (req.model === SONNET) {
			return this.#client.beta.messages.create({
				...base,
				betas: [SERVER_SIDE_FALLBACK_BETA],
				fallbacks: "default",
			});
		}
		return this.#client.messages.create(base);
	}
}
