import {
	type DomainError,
	err,
	invalidStateTransition,
	newId,
	ok,
	permissionDenied,
	type Result,
} from "@yunomi/core";
import type { CallContext, CapabilityRequest } from "./contract.ts";

export type PendingStatus =
	| "proposed"
	| "executed"
	| "failed"
	| "cancelled"
	| "expired";

/** policy が confirm の道具について、オーナーの了承を待っている操作。 */
export type PendingOperation = {
	readonly id: string;
	readonly partnerId: string;
	readonly channelId: string;
	readonly tool: string;
	/** 検証済みの入力。 */
	readonly input: unknown;
	/** 提案を引き起こした発言者の id。 */
	readonly requestedBy: string;
	readonly sourceMessageId: string;
	/** UTC の ISO 文字列。 */
	readonly createdAt: string;
	/** UTC の ISO 文字列。 */
	readonly expiresAt: string;
	readonly status: PendingStatus;
	/** 未解決（proposed）の間は null。 */
	readonly resolvedAt: string | null;
};

export const PENDING_TTL_MS = 10 * 60 * 1000;

export type ConfirmResult =
	| { type: "ready"; op: PendingOperation }
	| { type: "expired"; op: PendingOperation }
	| { type: "rejected"; error: DomainError };

const ENTITY = "PendingOperation";

const resolve = (
	op: PendingOperation,
	status: Exclude<PendingStatus, "proposed">,
	now: Date,
): PendingOperation => ({ ...op, status, resolvedAt: now.toISOString() });

// 期限ちょうどは切れている側に倒す。confirm と expireDue で境界を揃えるためここに一本化する。
const isDue = (op: PendingOperation, now: Date): boolean =>
	now.getTime() >= Date.parse(op.expiresAt);

/**
 * 同じ partner・同じチャンネルの proposed は新しい提案で取り消す。
 * 古い保留が残ると、次のターンの「いいよ」がどの提案への了承か曖昧になる。
 */
export const propose = (
	request: CapabilityRequest,
	open: readonly PendingOperation[],
	now: Date,
): { created: PendingOperation; superseded: readonly PendingOperation[] } => {
	const { context } = request;
	const superseded = open
		.filter(
			(op) =>
				op.status === "proposed" &&
				op.partnerId === context.partnerId &&
				op.channelId === context.channelId,
		)
		.map((op) => resolve(op, "cancelled", now));
	const created: PendingOperation = {
		id: newId(),
		partnerId: context.partnerId,
		channelId: context.channelId,
		tool: request.tool,
		input: request.input,
		requestedBy: context.speakerId,
		sourceMessageId: context.sourceMessageId,
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
		status: "proposed",
		resolvedAt: null,
	};
	return { created, superseded };
};

/**
 * 了承を受けて実行してよいかを判定する。ready の op は proposed のままで、
 * 実行の結果は `complete` で反映する。
 */
export const confirm = (
	op: PendingOperation,
	context: Pick<CallContext, "isOwner">,
	now: Date,
): ConfirmResult => {
	if (op.status !== "proposed") {
		return {
			type: "rejected",
			error: invalidStateTransition({
				entity: ENTITY,
				from: op.status,
				to: "executed",
			}),
		};
	}
	if (!context.isOwner) {
		return {
			type: "rejected",
			error: permissionDenied({
				actor: "non_owner",
				action: "pending.confirm",
			}),
		};
	}
	if (isDue(op, now))
		return { type: "expired", op: resolve(op, "expired", now) };
	return { type: "ready", op };
};

export const complete = (
	op: PendingOperation,
	outcome: "executed" | "failed",
	now: Date,
): Result<PendingOperation, DomainError> => {
	if (op.status !== "proposed") {
		return err(
			invalidStateTransition({ entity: ENTITY, from: op.status, to: outcome }),
		);
	}
	return ok(resolve(op, outcome, now));
};

export const cancel = (
	op: PendingOperation,
	now: Date,
): Result<PendingOperation, DomainError> => {
	if (op.status !== "proposed") {
		return err(
			invalidStateTransition({
				entity: ENTITY,
				from: op.status,
				to: "cancelled",
			}),
		);
	}
	return ok(resolve(op, "cancelled", now));
};

/** 期限を過ぎた proposed だけを expired にして返す。 */
export const expireDue = (
	ops: readonly PendingOperation[],
	now: Date,
): readonly PendingOperation[] =>
	ops
		.filter((op) => op.status === "proposed" && isDue(op, now))
		.map((op) => resolve(op, "expired", now));
