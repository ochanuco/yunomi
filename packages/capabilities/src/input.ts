import {
	type DomainError,
	err,
	ok,
	type Result,
	validationFailed,
} from "@yunomi/core";
import * as v from "valibot";
import type { ToolDefinition } from "./contract.ts";

const formatIssue = (issue: v.BaseIssue<unknown>): string => {
	const path = v.getDotPath(issue);
	return path === null ? issue.message : `${path}: ${issue.message}`;
};

/** LLM から届いた道具の入力を検証する。境界なので Valibot を使う。 */
export const parseToolInput = <TInput>(
	def: Pick<ToolDefinition<TInput>, "input">,
	raw: unknown,
): Result<TInput, DomainError> => {
	const parsed = v.safeParse(def.input, raw);
	if (parsed.success) return ok(parsed.output);
	return err(validationFailed({ issues: parsed.issues.map(formatIssue) }));
};
