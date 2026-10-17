import type { DomainError, Result } from "@yunomi/core";
import type * as v from "valibot";

export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";
export type ModelId = typeof SONNET | typeof HAIKU;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type SystemBlock = { text: string; cache: boolean };

export type ChatMessage = { role: "user" | "assistant"; content: string };

declare const continuationBrand: unique symbol;

/**
 * provider 固有の assistant 応答（thinking を含む）。
 * 中身は読まず、次の step の messages にそのまま入れる。
 */
export type AssistantContinuation = { readonly [continuationBrand]: true };

/** provider に依存しない道具の定義。inputSchema は JSON Schema。 */
export type ToolSpec = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
};

export type ToolCall = { id: string; name: string; input: unknown };

export type ToolResult = {
	toolCallId: string;
	content: string;
	isError: boolean;
};

export type StepMessage =
	| ChatMessage
	| { role: "assistant"; continuation: AssistantContinuation }
	/** 並列の tool_use への結果は 1 つにまとめる。 */
	| { role: "tool_results"; results: readonly ToolResult[] };

export type OutputSpec<T> = {
	schema: v.GenericSchema<unknown, T>;
	jsonSchema: Record<string, unknown>;
	name: string;
};

export type LLMRequest<T> = {
	system: SystemBlock[];
	messages: ChatMessage[];
	output: OutputSpec<T>;
	model: ModelId;
	maxTokens: number;
	/** 省略時は provider の既定（会話ターンは low）。 */
	effort?: Effort;
	/** 省略時は provider の既定。 */
	timeoutMs?: number;
};

export type StepRequest<T> = Omit<LLMRequest<T>, "messages"> & {
	messages: readonly StepMessage[];
	tools: readonly ToolSpec[];
};

export type Usage = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
};

export type LLMResult<T> = {
	output: T;
	model: string;
	usage: Usage;
	latencyMs: number;
	stopReason: string | null;
};

export type LLMResultMeta = Omit<LLMResult<unknown>, "output">;

export type StepResult<T> =
	| (LLMResultMeta & { kind: "final"; output: T })
	| (LLMResultMeta & {
			kind: "tool_use";
			toolCalls: readonly ToolCall[];
			continuation: AssistantContinuation;
	  });

export interface LLMProvider {
	generate<T>(req: LLMRequest<T>): Promise<Result<LLMResult<T>, DomainError>>;
	/** 道具を使えない provider は省略する。 */
	step?<T>(req: StepRequest<T>): Promise<Result<StepResult<T>, DomainError>>;
}
