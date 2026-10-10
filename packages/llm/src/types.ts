import type { DomainError, Result } from "@yunomi/core";
import type * as v from "valibot";

export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";
export type ModelId = typeof SONNET | typeof HAIKU;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type SystemBlock = { text: string; cache: boolean };

export type ChatMessage = { role: "user" | "assistant"; content: string };

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

export interface LLMProvider {
	generate<T>(req: LLMRequest<T>): Promise<Result<LLMResult<T>, DomainError>>;
}
