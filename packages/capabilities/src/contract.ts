import type { DomainError, Result } from "@yunomi/core";
import type * as v from "valibot";

/** LLM に見せる道具の定義。provider の形式への変換は呼び出し側が行う。 */
export type ToolDefinition<TInput = unknown> = {
	/** LLM に見せる名前。snake_case。 */
	readonly name: string;
	/** LLM 向けの説明。 */
	readonly description: string;
	/** Partner の `capability_defaults` のキー。 */
	readonly category: string;
	readonly input: v.GenericSchema<unknown, TInput>;
};

export type CallContext = {
	readonly partnerId: string;
	readonly speakerId: string;
	readonly isOwner: boolean;
	readonly channelId: string;
	readonly sourceMessageId: string;
	/** sourceMessageId の返信先。返信でなければ null か省略。 */
	readonly replyToMessageId?: string | null;
	readonly now: Date;
};

export type CapabilityRequest<TInput = unknown> = {
	/** `newId()` で作る。 */
	readonly requestId: string;
	readonly tool: string;
	readonly input: TInput;
	readonly context: CallContext;
};

/** 道具の結果に添える画像。data は base64。 */
export type ToolImage = {
	readonly mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
	readonly data: string;
};

export type CapabilityResponse = {
	/** brain に返す結果。JSON にできる値。 */
	readonly data: unknown;
	/** brain に画像として見せるもの。JSON の data には入れない。 */
	readonly images?: readonly ToolImage[];
	/** Audit 用の短い要約。秘密やメール本文を入れない。 */
	readonly summary: string;
};

export type CapabilityAdapter = {
	readonly tools: readonly ToolDefinition[];
	execute(
		request: CapabilityRequest,
	): Promise<Result<CapabilityResponse, DomainError>>;
};
