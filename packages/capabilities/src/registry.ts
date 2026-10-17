import {
	type DomainError,
	err,
	ok,
	type Result,
	validationFailed,
} from "@yunomi/core";
import type { CapabilityAdapter, ToolDefinition } from "./contract.ts";

export type RegisteredTool = {
	readonly definition: ToolDefinition;
	readonly adapter: CapabilityAdapter;
};

export type ToolRegistry = {
	/** adapter を渡した順のまま並べる。毎ターン同じ並びで LLM に渡すことで prompt cache を保つ。 */
	readonly definitions: readonly ToolDefinition[];
	find(name: string): RegisteredTool | undefined;
};

export const createToolRegistry = (
	adapters: readonly CapabilityAdapter[],
): Result<ToolRegistry, DomainError> => {
	const byName = new Map<string, RegisteredTool>();
	const duplicates: string[] = [];
	for (const adapter of adapters) {
		for (const definition of adapter.tools) {
			if (byName.has(definition.name)) {
				duplicates.push(`道具名 ${definition.name} が重複している`);
				continue;
			}
			byName.set(definition.name, { definition, adapter });
		}
	}
	if (duplicates.length > 0)
		return err(validationFailed({ issues: duplicates }));
	return ok({
		definitions: [...byName.values()].map((entry) => entry.definition),
		find: (name) => byName.get(name),
	});
};
