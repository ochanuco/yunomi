export type DegradedEffect = "none" | "degrade";
export type AuditSeverity = "info" | "warn" | "error";

type ErrorMeta = {
	message: string;
	retryable: boolean;
	userVisible: boolean;
	degradedEffect: DegradedEffect;
	auditSeverity: AuditSeverity;
};

type Kind<TType extends string, TFields> = { type: TType } & ErrorMeta &
	TFields;

export type MemoryConflict = Kind<
	"MemoryConflict",
	{ memoryId: string; expectedVersion: number; actualVersion: number }
>;
export type InvalidStateTransition = Kind<
	"InvalidStateTransition",
	{ entity: string; from: string; to: string }
>;
export type RelationshipUpdateRejected = Kind<
	"RelationshipUpdateRejected",
	{ partnerId: string; reason: string }
>;
export type PermissionDenied = Kind<
	"PermissionDenied",
	{ actor: string; action: string }
>;
export type ToolExecutionRejected = Kind<
	"ToolExecutionRejected",
	{ tool: string; reason: string }
>;
export type ExternalServiceUnavailable = Kind<
	"ExternalServiceUnavailable",
	{ service: string }
>;
export type RateLimited = Kind<"RateLimited", { retryAfterMs: number | null }>;
export type ValidationFailed = Kind<
	"ValidationFailed",
	{ issues: readonly string[] }
>;

export type DomainError =
	| MemoryConflict
	| InvalidStateTransition
	| RelationshipUpdateRejected
	| PermissionDenied
	| ToolExecutionRejected
	| ExternalServiceUnavailable
	| RateLimited
	| ValidationFailed;

export const memoryConflict = (
	f: Pick<MemoryConflict, "memoryId" | "expectedVersion" | "actualVersion">,
): MemoryConflict => ({
	type: "MemoryConflict",
	message: `memory ${f.memoryId} は version ${f.expectedVersion} を期待したが ${f.actualVersion} だった`,
	retryable: true,
	userVisible: false,
	degradedEffect: "none",
	auditSeverity: "info",
	...f,
});

export const invalidStateTransition = (
	f: Pick<InvalidStateTransition, "entity" | "from" | "to">,
): InvalidStateTransition => ({
	type: "InvalidStateTransition",
	message: `${f.entity} は ${f.from} から ${f.to} へ遷移できない`,
	retryable: false,
	userVisible: false,
	degradedEffect: "none",
	auditSeverity: "error",
	...f,
});

export const relationshipUpdateRejected = (
	f: Pick<RelationshipUpdateRejected, "partnerId" | "reason">,
): RelationshipUpdateRejected => ({
	type: "RelationshipUpdateRejected",
	message: `partner ${f.partnerId} の関係性更新を拒否した: ${f.reason}`,
	retryable: false,
	userVisible: false,
	degradedEffect: "none",
	auditSeverity: "warn",
	...f,
});

export const permissionDenied = (
	f: Pick<PermissionDenied, "actor" | "action">,
): PermissionDenied => ({
	type: "PermissionDenied",
	message: `${f.actor} に ${f.action} の権限がない`,
	retryable: false,
	userVisible: true,
	degradedEffect: "none",
	auditSeverity: "warn",
	...f,
});

export const toolExecutionRejected = (
	f: Pick<ToolExecutionRejected, "tool" | "reason">,
): ToolExecutionRejected => ({
	type: "ToolExecutionRejected",
	message: `tool ${f.tool} の実行を拒否した: ${f.reason}`,
	retryable: false,
	userVisible: true,
	degradedEffect: "degrade",
	auditSeverity: "warn",
	...f,
});

export const externalServiceUnavailable = (
	f: Pick<ExternalServiceUnavailable, "service">,
): ExternalServiceUnavailable => ({
	type: "ExternalServiceUnavailable",
	message: `外部サービス ${f.service} が利用できない`,
	retryable: true,
	userVisible: false,
	degradedEffect: "degrade",
	auditSeverity: "error",
	...f,
});

export const rateLimited = (
	f: Pick<RateLimited, "retryAfterMs"> = { retryAfterMs: null },
): RateLimited => ({
	type: "RateLimited",
	message: "レート制限に達した",
	retryable: true,
	userVisible: true,
	degradedEffect: "degrade",
	auditSeverity: "info",
	...f,
});

export const validationFailed = (
	f: Pick<ValidationFailed, "issues">,
): ValidationFailed => ({
	type: "ValidationFailed",
	message: `入力が不正: ${f.issues.join(", ")}`,
	retryable: false,
	userVisible: true,
	degradedEffect: "none",
	auditSeverity: "info",
	...f,
});
