import {
	type CapabilityMode,
	type ToolExecutionRejected,
	toolExecutionRejected,
} from "@yunomi/core";
import type { CallContext, ToolDefinition } from "./contract.ts";

/** Partner の `capability_defaults`。キーは道具の category。 */
export type CapabilityPolicy = Readonly<Record<string, CapabilityMode>>;

export type DenyReason = "not_owner" | "unknown_category" | "policy_deny";

export type PolicyDecision =
	| { type: "auto" }
	| { type: "confirm" }
	| { type: "deny"; reason: DenyReason };

/**
 * オーナー以外は category の設定より先に拒否する。
 * policy に無い category を暗黙に許可しないよう、未定義は deny にする。
 */
export const decide = (
	policy: CapabilityPolicy,
	tool: Pick<ToolDefinition, "category">,
	context: Pick<CallContext, "isOwner">,
): PolicyDecision => {
	if (!context.isOwner) return { type: "deny", reason: "not_owner" };
	// constructor などの継承されたキーを category として拾わないよう、自身のキーだけを見る。
	const mode = Object.hasOwn(policy, tool.category)
		? policy[tool.category]
		: undefined;
	if (mode === undefined) return { type: "deny", reason: "unknown_category" };
	if (mode === "deny") return { type: "deny", reason: "policy_deny" };
	return { type: mode };
};

export const rejectionFor = (
	tool: Pick<ToolDefinition, "name">,
	decision: Extract<PolicyDecision, { type: "deny" }>,
): ToolExecutionRejected =>
	toolExecutionRejected({ tool: tool.name, reason: decision.reason });
