import Anthropic from "@anthropic-ai/sdk";
import {
	type DomainError,
	err,
	ok,
	type Result,
	validationFailed,
} from "@yunomi/core";
import * as v from "valibot";
import { anthropicContent, anthropicContinuation } from "./continuation.ts";
import { mapSdkError, refusalError } from "./errors.ts";
import {
	type Effort,
	type LLMProvider,
	type LLMRequest,
	type LLMResult,
	type LLMResultMeta,
	type ModelId,
	SONNET,
	type StepMessage,
	type StepRequest,
	type StepResult,
	type SystemBlock,
	type ToolCall,
	type ToolSpec,
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

type ContentBlockLike = {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
};

type ResponseLike = {
	model: string;
	stop_reason: string | null;
	content: ContentBlockLike[];
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_read_input_tokens?: number | null;
		cache_creation_input_tokens?: number | null;
	};
};

type CallInput = {
	system: SystemBlock[];
	messages: Anthropic.MessageParam[];
	jsonSchema: Record<string, unknown>;
	model: ModelId;
	maxTokens: number;
	effort?: Effort;
	timeoutMs?: number;
	tools?: Anthropic.Tool[];
};

const toMessageParam = (m: StepMessage): Anthropic.MessageParam => {
	if (m.role === "tool_results") {
		return {
			role: "user",
			content: m.results.map((r) => ({
				type: "tool_result" as const,
				tool_use_id: r.toolCallId,
				content: r.images?.length
					? [
							{ type: "text" as const, text: r.content },
							...r.images.map((img) => ({
								type: "image" as const,
								source: {
									type: "base64" as const,
									media_type: img.mediaType,
									data: img.data,
								},
							})),
						]
					: r.content,
				is_error: r.isError,
			})),
		};
	}
	if ("continuation" in m) {
		return {
			role: "assistant",
			content: anthropicContent(
				m.continuation,
			) as Anthropic.ContentBlockParam[],
		};
	}
	return { role: m.role, content: m.content };
};

// strict を付けると、output_config.format の文法と道具の文法が合算され、
// 道具が 6 つ前後で "compiled grammar is too large" の 400 になる。入力は gate が Valibot で再検証する。
const toToolParam = (s: ToolSpec): Anthropic.Tool => ({
	name: s.name,
	description: s.description,
	input_schema: s.inputSchema as Anthropic.Tool["input_schema"],
});

const metaOf = (res: ResponseLike, started: number): LLMResultMeta => ({
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

const parseOutput = <T>(
	res: ResponseLike,
	schema: v.GenericSchema<unknown, T>,
): Result<T, DomainError> => {
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
	const parsed = v.safeParse(schema, json);
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
	return ok(parsed.output);
};

const parseToolCalls = (
	res: ResponseLike,
): Result<readonly ToolCall[], DomainError> => {
	const calls: ToolCall[] = [];
	for (const b of res.content) {
		if (b.type !== "tool_use") continue;
		if (typeof b.id !== "string" || typeof b.name !== "string") {
			return err(
				validationFailed({ issues: ["tool_use ブロックに id / name が無い"] }),
			);
		}
		calls.push({ id: b.id, name: b.name, input: b.input });
	}
	if (calls.length === 0) {
		return err(
			validationFailed({
				issues: ["stop_reason が tool_use なのに tool_use ブロックが無い"],
			}),
		);
	}
	return ok(calls);
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
			res = await this.#call({
				...req,
				jsonSchema: req.output.jsonSchema,
			});
		} catch (e) {
			return err(mapSdkError(e));
		}
		if (res.stop_reason === "refusal") return err(refusalError());

		const parsed = parseOutput(res, req.output.schema);
		if (!parsed.ok) return err(parsed.error);
		return ok({ output: parsed.value, ...metaOf(res, started) });
	}

	/**
	 * 道具を渡して 1 往復する。tool_use なら toolCalls と continuation を返し、
	 * 呼び出し側が結果を tool_results として次の step に渡す。
	 */
	async step<T>(
		req: StepRequest<T>,
	): Promise<Result<StepResult<T>, DomainError>> {
		const started = Date.now();
		let res: ResponseLike;
		try {
			res = await this.#call({
				...req,
				jsonSchema: req.output.jsonSchema,
				messages: req.messages.map(toMessageParam),
				tools: req.tools.map(toToolParam),
			});
		} catch (e) {
			return err(mapSdkError(e));
		}
		if (res.stop_reason === "refusal") return err(refusalError());

		const meta = metaOf(res, started);
		if (res.stop_reason === "tool_use") {
			const calls = parseToolCalls(res);
			if (!calls.ok) return err(calls.error);
			return ok({
				kind: "tool_use",
				toolCalls: calls.value,
				// thinking を含む content 全体を次のリクエストへそのまま返す必要がある。
				continuation: anthropicContinuation(res.content),
				...meta,
			});
		}

		const parsed = parseOutput(res, req.output.schema);
		if (!parsed.ok) return err(parsed.error);
		return ok({ kind: "final", output: parsed.value, ...meta });
	}

	#call(req: CallInput): Promise<ResponseLike> {
		const base = {
			model: req.model,
			max_tokens: req.maxTokens,
			system: req.system.map((b) => ({
				type: "text" as const,
				text: b.text,
				...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
			})),
			messages: req.messages,
			// tool_choice は指定しない。Sonnet 5.5 / Haiku 5.5 は forced の tool_choice を受け付けない。
			...(req.tools?.length ? { tools: req.tools } : {}),
			output_config: {
				effort: req.effort ?? this.#effort,
				format: {
					type: "json_schema" as const,
					schema: req.jsonSchema,
				},
			},
		};
		const options = req.timeoutMs ? { timeout: req.timeoutMs } : undefined;
		if (req.model === SONNET) {
			return this.#client.beta.messages.create(
				{
					...base,
					betas: [SERVER_SIDE_FALLBACK_BETA],
					fallbacks: "default",
				},
				options,
			);
		}
		return this.#client.messages.create(base, options);
	}
}
