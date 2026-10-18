import {
	type DomainError,
	err,
	externalServiceUnavailable,
	newId,
	type Result,
	toModelJson,
	toolExecutionRejected,
} from "@yunomi/core";
import * as v from "valibot";
import type {
	CallContext,
	CapabilityAdapter,
	CapabilityRequest,
	CapabilityResponse,
	ToolDefinition,
	ToolImage,
} from "./contract.ts";
import { parseToolInput } from "./input.ts";
import {
	cancel,
	complete,
	confirm,
	type PendingOperation,
	propose,
} from "./pending.ts";
import { type CapabilityPolicy, decide, rejectionFor } from "./policy.ts";
import type { ToolRegistry } from "./registry.ts";

export type PendingStore = {
	/** status が proposed のもの。 */
	listOpen(
		partnerId: string,
		channelId: string,
	): Promise<readonly PendingOperation[]>;
	get(partnerId: string, id: string): Promise<PendingOperation | null>;
	/** id で upsert する。 */
	save(ops: readonly PendingOperation[]): Promise<void>;
};

export type ToolCallRecord = {
	tool: string;
	decision:
		| "auto"
		| "confirm"
		| "deny"
		| "invalid"
		| "unknown"
		| "pending_confirm"
		| "pending_cancel";
	outcome:
		| "ok"
		| "error"
		| "pending"
		| "denied"
		| "expired"
		| "cancelled"
		| "not_found";
	/** Audit 用。adapter の summary か拒否の理由。秘密や予定・メールの本文を入れない。 */
	summary: string;
	pendingId: string | null;
	latencyMs: number;
};

export type GateResult = {
	/** brain に返す JSON 文字列。 */
	content: string;
	/** 結果に添える画像。道具が返したときだけある。 */
	images?: readonly ToolImage[];
	isError: boolean;
	record: ToolCallRecord;
};

export type CapabilityGate = {
	/** 登録簿の定義に pending_confirm と pending_cancel を足したもの。毎ターン同じ順で返す。 */
	readonly definitions: readonly ToolDefinition[];
	handle(
		call: { name: string; input: unknown },
		context: CallContext,
	): Promise<GateResult>;
};

export const PENDING_CONFIRM_TOOL = "pending_confirm";
export const PENDING_CANCEL_TOOL = "pending_cancel";

const pendingInput = v.object({
	pending_id: v.pipe(v.string(), v.description("「保留中の操作」にある id")),
});

type PendingInput = v.InferOutput<typeof pendingInput>;

// policy の対象外。保留の了承と取り消しは gate 自身が扱い、category は使わない。
const PENDING_CATEGORY = "pending";

export const pendingConfirmDefinition: ToolDefinition<PendingInput> = {
	name: PENDING_CONFIRM_TOOL,
	description:
		"オーナーが保留中の操作を了承したときに呼ぶ。pending_id は『保留中の操作』にある id。",
	category: PENDING_CATEGORY,
	input: pendingInput,
};

export const pendingCancelDefinition: ToolDefinition<PendingInput> = {
	name: PENDING_CANCEL_TOOL,
	description:
		"オーナーが保留中の操作を断ったとき、または内容を変えたいと言ったときに呼ぶ。",
	category: PENDING_CATEGORY,
	input: pendingInput,
};

const PENDING_NOTE =
	"まだ実行していない。内容をオーナーに確認し、了承されたら pending_confirm、断られたら pending_cancel を呼ぶ。";
const EXPIRED_NOTE =
	"期限が切れたので実行していない。必要ならもう一度提案する。";

type Handled = {
	body: Readonly<Record<string, unknown>>;
	isError: boolean;
	decision: ToolCallRecord["decision"];
	outcome: ToolCallRecord["outcome"];
	summary: string;
	pendingId?: string;
	images?: readonly ToolImage[];
};

const failureBody = (error: DomainError) => ({
	status: "error",
	error: error.type,
	retryable: error.retryable,
});

// 失敗の message は adapter が組むので Audit には載せず、型名だけを残す。
const failed = (
	decision: Handled["decision"],
	error: DomainError,
	pendingId?: string,
): Handled => ({
	body: failureBody(error),
	isError: true,
	decision,
	outcome: "error",
	summary: error.type,
	...(pendingId === undefined ? {} : { pendingId }),
});

const notFound = (decision: Handled["decision"]): Handled => ({
	body: { status: "not_found" },
	isError: true,
	decision,
	outcome: "not_found",
	summary: "該当する保留がない",
});

const notOwner = (
	decision: "pending_confirm" | "pending_cancel",
	pendingId: string,
): Handled => ({
	body: { status: "denied", reason: "not_owner" },
	isError: true,
	decision,
	outcome: "denied",
	summary: "not_owner",
	pendingId,
});

const invalidPendingInput = (
	decision: "pending_confirm" | "pending_cancel",
	error: DomainError,
): Handled => ({
	body: {
		status: "invalid_input",
		issues: error.type === "ValidationFailed" ? error.issues : [],
	},
	isError: true,
	decision: "invalid",
	outcome: "error",
	summary: `${decision} の入力が不正`,
});

// adapter が例外を投げても gate の外へ漏らさず、外部サービスの失敗として扱う。
const runAdapter = async (
	adapter: CapabilityAdapter,
	request: CapabilityRequest,
): Promise<Result<CapabilityResponse, DomainError>> => {
	try {
		return await adapter.execute(request);
	} catch {
		return err(
			externalServiceUnavailable({ service: `capability:${request.tool}` }),
		);
	}
};

export const createCapabilityGate = (deps: {
	registry: ToolRegistry;
	policy: CapabilityPolicy;
	pending: PendingStore;
	now: () => Date;
}): CapabilityGate => {
	const { registry, policy, pending, now } = deps;

	const callTool = async (
		call: { name: string; input: unknown },
		context: CallContext,
	): Promise<Handled> => {
		const entry = registry.find(call.name);
		if (!entry) {
			return {
				body: { status: "unknown_tool" },
				isError: true,
				decision: "unknown",
				outcome: "error",
				summary: "登録されていない道具",
			};
		}
		const { definition, adapter } = entry;

		// 入力の検証より先に判定する。オーナー以外に入力の形を教えず、直して呼び直す往復も起こさない。
		const decision = decide(policy, definition, context);
		if (decision.type === "deny") {
			const reason = rejectionFor(definition, decision).reason;
			return {
				body: { status: "denied", reason },
				isError: true,
				decision: "deny",
				outcome: "denied",
				summary: reason,
			};
		}

		const parsed = parseToolInput(definition, call.input);
		if (!parsed.ok) {
			const issues =
				parsed.error.type === "ValidationFailed" ? parsed.error.issues : [];
			return {
				body: { status: "invalid_input", issues },
				isError: true,
				decision: "invalid",
				outcome: "error",
				summary: "入力が不正",
			};
		}

		const request: CapabilityRequest = {
			requestId: newId(),
			tool: definition.name,
			input: parsed.value,
			context,
		};

		if (decision.type === "auto") {
			const result = await runAdapter(adapter, request);
			if (!result.ok) return failed("auto", result.error);
			return {
				body: { status: "ok", result: result.value.data },
				isError: false,
				decision: "auto",
				outcome: "ok",
				summary: result.value.summary,
				...(result.value.images?.length ? { images: result.value.images } : {}),
			};
		}

		let created: PendingOperation;
		try {
			const open = await pending.listOpen(context.partnerId, context.channelId);
			const proposal = propose(request, open, now());
			await pending.save([proposal.created, ...proposal.superseded]);
			created = proposal.created;
		} catch {
			return failed(
				"confirm",
				externalServiceUnavailable({ service: "pending_store" }),
			);
		}
		return {
			body: {
				status: "pending_confirmation",
				pending_id: created.id,
				expires_at: created.expiresAt,
				note: PENDING_NOTE,
			},
			isError: false,
			decision: "confirm",
			outcome: "pending",
			summary: `${definition.name} を保留にした`,
			pendingId: created.id,
		};
	};

	// 別チャンネルの保留は、id を知っていても扱わせない。
	const findPending = async (
		pendingId: string,
		context: CallContext,
	): Promise<PendingOperation | null> => {
		const op = await pending.get(context.partnerId, pendingId);
		return op !== null && op.channelId === context.channelId ? op : null;
	};

	const confirmPending = async (
		call: { name: string; input: unknown },
		context: CallContext,
	): Promise<Handled> => {
		const parsed = parseToolInput(pendingConfirmDefinition, call.input);
		if (!parsed.ok) return invalidPendingInput("pending_confirm", parsed.error);
		const pendingId = parsed.value.pending_id;
		if (!context.isOwner) return notOwner("pending_confirm", pendingId);

		const op = await findPending(pendingId, context);
		if (!op) return notFound("pending_confirm");
		// ターンの頭で期限切れとして保存済みの保留にも、状態遷移のエラーではなく期限切れとして答える。
		if (op.status === "expired") {
			return {
				body: { status: "expired", note: EXPIRED_NOTE },
				isError: true,
				decision: "pending_confirm",
				outcome: "expired",
				summary: `${op.tool} の保留が期限切れ`,
				pendingId,
			};
		}

		const verdict = confirm(op, context, now());
		if (verdict.type === "rejected") {
			return {
				body: { status: "rejected", reason: verdict.error.type },
				isError: true,
				decision: "pending_confirm",
				outcome: "error",
				summary: verdict.error.type,
				pendingId,
			};
		}
		if (verdict.type === "expired") {
			await pending.save([verdict.op]);
			return {
				body: { status: "expired", note: EXPIRED_NOTE },
				isError: true,
				decision: "pending_confirm",
				outcome: "expired",
				summary: `${op.tool} の保留が期限切れ`,
				pendingId,
			};
		}

		const entry = registry.find(op.tool);
		const result = entry
			? await runAdapter(entry.adapter, {
					requestId: newId(),
					tool: op.tool,
					input: op.input,
					// 予定の ID は sourceMessageId から決まる。了承の発言ではなく元の依頼の発言を渡し、
					// 同じ依頼からの二重登録を Google に弾かせる。
					context: { ...context, sourceMessageId: op.sourceMessageId },
				})
			: err(toolExecutionRejected({ tool: op.tool, reason: "unknown_tool" }));

		const done = complete(op, result.ok ? "executed" : "failed", now());
		if (!done.ok) return failed("pending_confirm", done.error, pendingId);
		let recorded = true;
		try {
			await pending.save([done.value]);
		} catch (cause) {
			// 実行が済んでいるのに失敗と伝えると、オーナーに誤った案内になる。記録の失敗は結果に添える。
			if (!result.ok) throw cause;
			recorded = false;
		}

		if (!result.ok) return failed("pending_confirm", result.error, pendingId);
		return {
			body: {
				status: "executed",
				result: result.value.data,
				...(recorded ? {} : { note: "実行は済んだが、保留の記録に失敗した。" }),
			},
			isError: false,
			decision: "pending_confirm",
			outcome: "ok",
			summary: recorded
				? result.value.summary
				: `${result.value.summary}（保留の記録に失敗）`,
			pendingId,
		};
	};

	const cancelPending = async (
		call: { name: string; input: unknown },
		context: CallContext,
	): Promise<Handled> => {
		const parsed = parseToolInput(pendingCancelDefinition, call.input);
		if (!parsed.ok) return invalidPendingInput("pending_cancel", parsed.error);
		const pendingId = parsed.value.pending_id;
		if (!context.isOwner) return notOwner("pending_cancel", pendingId);

		const op = await findPending(pendingId, context);
		if (!op) return notFound("pending_cancel");

		const cancelled = cancel(op, now());
		if (!cancelled.ok) {
			return {
				body: { status: "rejected", reason: cancelled.error.type },
				isError: true,
				decision: "pending_cancel",
				outcome: "error",
				summary: cancelled.error.type,
				pendingId,
			};
		}
		await pending.save([cancelled.value]);
		return {
			body: { status: "cancelled" },
			isError: false,
			decision: "pending_cancel",
			outcome: "cancelled",
			summary: `${op.tool} の保留を取り消した`,
			pendingId,
		};
	};

	const dispatch = (
		call: { name: string; input: unknown },
		context: CallContext,
	): Promise<Handled> => {
		if (call.name === PENDING_CONFIRM_TOOL)
			return confirmPending(call, context);
		if (call.name === PENDING_CANCEL_TOOL) return cancelPending(call, context);
		return callTool(call, context);
	};

	return {
		definitions: [
			...registry.definitions,
			pendingConfirmDefinition,
			pendingCancelDefinition,
		],
		async handle(call, context) {
			const started = Date.now();
			const finish = (handled: Handled): GateResult => ({
				content: toModelJson(handled.body),
				...(handled.images ? { images: handled.images } : {}),
				isError: handled.isError,
				record: {
					tool: call.name,
					decision: handled.decision,
					outcome: handled.outcome,
					summary: handled.summary,
					pendingId: handled.pendingId ?? null,
					latencyMs: Date.now() - started,
				},
			});
			try {
				return finish(await dispatch(call, context));
			} catch {
				return finish(
					failed(
						call.name === PENDING_CONFIRM_TOOL
							? "pending_confirm"
							: call.name === PENDING_CANCEL_TOOL
								? "pending_cancel"
								: "unknown",
						externalServiceUnavailable({ service: `capability:${call.name}` }),
					),
				);
			}
		},
	};
};
