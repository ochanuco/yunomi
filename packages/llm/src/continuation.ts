import type { AssistantContinuation } from "./types.ts";

type AnthropicContinuation = {
	provider: "anthropic";
	content: readonly unknown[];
};

// AssistantContinuation は型の上でだけ不透明で、実体は provider ごとの形を持つ。
export const anthropicContinuation = (
	content: readonly unknown[],
): AssistantContinuation =>
	({ provider: "anthropic", content }) as unknown as AssistantContinuation;

export const anthropicContent = (
	continuation: AssistantContinuation,
): readonly unknown[] =>
	(continuation as unknown as AnthropicContinuation).content;
