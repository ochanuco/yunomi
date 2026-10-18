import type {
	CapabilityGate,
	PendingStore,
	ToolCallRecord,
} from "@yunomi/capabilities";
import { type TurnResponse, turnOutput } from "@yunomi/conversation";
import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
	validationFailed,
} from "@yunomi/core";
import {
	type ChatMessage,
	HAIKU,
	type ModelId,
	type ModelRouter,
	type RoutedResult,
	SONNET,
	type StepMessage,
	type SystemBlock,
	type ToolResult,
	type ToolSpec,
	toStructuredJsonSchema,
	type Usage,
} from "@yunomi/llm";

/** ターンに道具を持たせるための部品。組み立ては Worker の入口で行う。 */
export type TurnCapabilities = {
	gate: CapabilityGate;
	pending: Pick<PendingStore, "listOpen" | "save">;
	isOwner(speakerId: string): boolean;
};

/**
 * 道具を実行する往復の上限。予定の確認と登録の提案が重なっても 2〜3 往復で済むので、
 * 同じ呼び出しを繰り返す暴走を止められる値にしておく。
 */
export const MAX_TOOL_ROUNDS = 4;
/**
 * ループ全体の待ち時間の上限。チャンネルの処理は直列なので、
 * 遅い道具や繰り返しの呼び出しが、ほかの発言を待たせ続けないようにする。
 */
export const TOOL_LOOP_TIMEOUT_MS = 45_000;
// 上限を過ぎたあとの最後の 1 回にも、返事を組み立てられるだけの待ち時間を残す。
const MIN_STEP_TIMEOUT_MS = 10_000;

const LIMIT_REACHED_CONTENT = JSON.stringify({
	status: "not_executed",
	note: "道具の呼び出しが上限に達したので実行していない。これまでの結果だけで答える。",
});

export type ToolLoopArgs = {
	router: ModelRouter;
	capabilities: TurnCapabilities;
	now: () => Date;
	system: SystemBlock[];
	messages: ChatMessage[];
	maxTokens: number;
	partnerId: string;
	speaker: { id: string; isOwner: boolean };
	channelId: string;
	messageId: string;
	replyToMessageId?: string | null;
};

export type ToolLoopOutcome = {
	/** latencyMs は道具の実行を含む、ループ全体の経過時間。 */
	result: Result<RoutedResult<TurnResponse>, DomainError>;
	/** 失敗したターンにも、それまでに実行した道具の記録を残す。 */
	toolCalls: ToolCallRecord[];
};

const toToolSpecs = (gate: CapabilityGate): ToolSpec[] =>
	gate.definitions.map((def) => ({
		name: def.name,
		description: def.description,
		inputSchema: toStructuredJsonSchema(def.input),
	}));

const addUsage = (a: Usage, b: Usage): Usage => ({
	inputTokens: a.inputTokens + b.inputTokens,
	outputTokens: a.outputTokens + b.outputTokens,
	cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
	cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
});

const pinnedModel = (model: string): ModelId | undefined =>
	model === SONNET || model === HAIKU ? model : undefined;

/**
 * LLM の tool use を、final の出力が返るまで回す。
 * tool_use の呼び出しは並べ替えず 1 つずつ gate に渡す。同じ往復での保留の作成と取り消しの順序を保つため。
 */
export const runToolLoop = async (
	args: ToolLoopArgs,
): Promise<ToolLoopOutcome> => {
	const { router, capabilities, now } = args;
	const tools = toToolSpecs(capabilities.gate);
	const messages: StepMessage[] = [...args.messages];
	const toolCalls: ToolCallRecord[] = [];
	const wallStarted = Date.now();
	const deadline = now().getTime() + TOOL_LOOP_TIMEOUT_MS;
	let usage: Usage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	let fallbackUsed = false;
	// thinking を含む assistant の応答を次の step に戻すので、ターンの間は同じモデルを使い続ける。
	let model: ModelId | undefined;
	let rounds = 0;
	let closing = false;

	try {
		for (;;) {
			const res = await router.step({
				system: args.system,
				messages,
				tools,
				output: turnOutput,
				maxTokens: args.maxTokens,
				timeoutMs: Math.max(MIN_STEP_TIMEOUT_MS, deadline - now().getTime()),
				...(model === undefined ? {} : { model }),
			});
			if (!res.ok) return { result: err(res.error), toolCalls };
			const step = res.value;
			usage = addUsage(usage, step.usage);
			fallbackUsed ||= step.fallbackUsed;
			model ??= pinnedModel(step.model);

			if (step.kind === "final") {
				return {
					result: ok({
						output: step.output,
						model: step.model,
						usage,
						latencyMs: Date.now() - wallStarted,
						stopReason: step.stopReason,
						fallbackUsed,
					}),
					toolCalls,
				};
			}
			// 上限を過ぎたあとの最後の 1 回でも道具を呼ぶなら、これ以上は待たずに失敗にする。
			if (closing) {
				return {
					result: err(
						validationFailed({
							issues: ["道具の呼び出しが上限を超えても最終応答にならない"],
						}),
					),
					toolCalls,
				};
			}

			const overLimit =
				rounds >= MAX_TOOL_ROUNDS || now().getTime() >= deadline;
			const results: ToolResult[] = [];
			for (const call of step.toolCalls) {
				if (overLimit) {
					results.push({
						toolCallId: call.id,
						content: LIMIT_REACHED_CONTENT,
						isError: true,
					});
					continue;
				}
				const handled = await capabilities.gate.handle(
					{ name: call.name, input: call.input },
					{
						partnerId: args.partnerId,
						speakerId: args.speaker.id,
						isOwner: args.speaker.isOwner,
						channelId: args.channelId,
						sourceMessageId: args.messageId,
						replyToMessageId: args.replyToMessageId ?? null,
						now: now(),
					},
				);
				toolCalls.push(handled.record);
				results.push({
					toolCallId: call.id,
					content: handled.content,
					...(handled.images ? { images: handled.images } : {}),
					isError: handled.isError,
				});
			}
			messages.push(
				{ role: "assistant", continuation: step.continuation },
				{ role: "tool_results", results },
			);
			if (overLimit) closing = true;
			else rounds += 1;
		}
	} catch {
		return {
			result: err(externalServiceUnavailable({ service: "llm:unexpected" })),
			toolCalls,
		};
	}
};
