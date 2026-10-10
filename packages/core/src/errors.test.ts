import { describe, expect, it } from "vitest";
import {
	type DomainError,
	externalServiceUnavailable,
	invalidStateTransition,
	memoryConflict,
	permissionDenied,
	rateLimited,
	relationshipUpdateRejected,
	toolExecutionRejected,
	validationFailed,
} from "./errors.ts";

const all: DomainError[] = [
	memoryConflict({ memoryId: "m1", expectedVersion: 1, actualVersion: 2 }),
	invalidStateTransition({ entity: "task", from: "done", to: "open" }),
	relationshipUpdateRejected({ partnerId: "p1", reason: "cooldown" }),
	permissionDenied({ actor: "gateway", action: "memory.write" }),
	toolExecutionRejected({ tool: "calendar", reason: "not allowed" }),
	externalServiceUnavailable({ service: "anthropic" }),
	rateLimited({ retryAfterMs: 1000 }),
	validationFailed({ issues: ["a is required"] }),
];

describe("DomainError", () => {
	it("全ての種別が共通のメタデータを持つ", () => {
		for (const e of all) {
			expect(e.message).not.toBe("");
			expect(typeof e.retryable).toBe("boolean");
			expect(typeof e.userVisible).toBe("boolean");
			expect(["none", "degrade"]).toContain(e.degradedEffect);
			expect(["info", "warn", "error"]).toContain(e.auditSeverity);
		}
		expect(new Set(all.map((e) => e.type)).size).toBe(8);
	});

	it("種別固有のフィールドを保持する", () => {
		const e = memoryConflict({
			memoryId: "m1",
			expectedVersion: 1,
			actualVersion: 2,
		});
		expect(e).toMatchObject({
			type: "MemoryConflict",
			memoryId: "m1",
			actualVersion: 2,
		});
	});

	it("再試行可否と縮退の既定値が種別ごとに決まっている", () => {
		expect(externalServiceUnavailable({ service: "x" })).toMatchObject({
			retryable: true,
			degradedEffect: "degrade",
			auditSeverity: "error",
		});
		expect(permissionDenied({ actor: "a", action: "b" })).toMatchObject({
			retryable: false,
			userVisible: true,
		});
		expect(rateLimited().retryAfterMs).toBeNull();
	});

	it("type で網羅的に分岐できる", () => {
		const label = (e: DomainError): string => {
			switch (e.type) {
				case "MemoryConflict":
				case "InvalidStateTransition":
				case "RelationshipUpdateRejected":
				case "PermissionDenied":
				case "ToolExecutionRejected":
				case "ExternalServiceUnavailable":
				case "RateLimited":
				case "ValidationFailed":
					return e.type;
			}
		};
		expect(all.map(label)).toHaveLength(8);
	});
});
