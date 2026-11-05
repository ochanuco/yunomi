import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest, ApprovalStore } from "./approval-store.ts";
import { createLedger } from "./guard/ledger.ts";

export const memoryApprovals = (): ApprovalStore & {
	all: Map<string, ApprovalRequest>;
} => {
	const all = new Map<string, ApprovalRequest>();
	return {
		all,
		get: (id) => all.get(id) ?? null,
		set: async (id, r) => {
			all.set(id, r);
		},
		delete: async (id) => {
			all.delete(id);
		},
	};
};

export const tempDir = (prefix = "yunomi-working-") =>
	mkdtempSync(join(tmpdir(), prefix));

export const tempLedger = (dir = tempDir()) => createLedger(dir);
