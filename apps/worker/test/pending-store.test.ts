import { runInDurableObject } from "cloudflare:test";
import type { PendingOperation, PendingStore } from "@yunomi/capabilities";
import { describe, expect, it } from "vitest";
import { createPendingStore } from "../src/do/pending-store.ts";
import { partnerStub } from "./helpers.ts";

let seq = 0;
// DO ごとに別の SQLite を持つので、テストごとに別名の DO を使い、行が混ざらないようにする。
const withStore = (fn: (store: PendingStore) => Promise<void>) => {
	seq += 1;
	return runInDurableObject(partnerStub(`pending-store-${seq}`), (_o, st) =>
		fn(createPendingStore(st.storage.sql)),
	);
};

const op = (over: Partial<PendingOperation> = {}): PendingOperation => {
	seq += 1;
	return {
		id: `op-${seq}`,
		partnerId: "yukarin",
		channelId: "c1",
		tool: "calendar_create_event",
		input: {
			summary: "歯医者",
			start: "2026-10-12T19:00:00+09:00",
			end: "2026-10-12T20:00:00+09:00",
			description: null,
		},
		requestedBy: "u1",
		sourceMessageId: "100000000000000001",
		createdAt: "2026-10-11T03:00:00.000Z",
		expiresAt: "2026-10-11T03:10:00.000Z",
		status: "proposed",
		resolvedAt: null,
		...over,
	};
};

describe("DO SQLite の PendingStore", () => {
	it("保存した操作を get で同じ形のまま読み出せる", () =>
		withStore(async (store) => {
			const saved = op();
			await store.save([saved]);
			expect(await store.get("yukarin", saved.id)).toEqual(saved);
		}));

	it("存在しない id と、別の partner の id は null", () =>
		withStore(async (store) => {
			const saved = op();
			await store.save([saved]);
			expect(await store.get("yukarin", "missing")).toBeNull();
			expect(await store.get("other", saved.id)).toBeNull();
		}));

	it("同じ id の save は上書き（upsert）で、行は増えない", () =>
		withStore(async (store) => {
			const saved = op();
			await store.save([saved]);
			const resolved: PendingOperation = {
				...saved,
				status: "executed",
				resolvedAt: "2026-10-11T03:01:00.000Z",
			};
			await store.save([resolved]);
			expect(await store.get("yukarin", saved.id)).toEqual(resolved);
			expect(await store.listOpen("yukarin", "c1")).toEqual([]);
		}));

	it("listOpen は同じ partner・チャンネルの proposed だけを作成順に返す", () =>
		withStore(async (store) => {
			const first = op({ createdAt: "2026-10-11T03:00:00.000Z" });
			const second = op({ createdAt: "2026-10-11T03:02:00.000Z" });
			await store.save([
				second,
				first,
				op({ channelId: "c2" }),
				op({ partnerId: "other" }),
				op({ status: "executed", resolvedAt: "2026-10-11T03:01:00.000Z" }),
				op({ status: "cancelled", resolvedAt: "2026-10-11T03:01:00.000Z" }),
				op({ status: "expired", resolvedAt: "2026-10-11T03:11:00.000Z" }),
				op({ status: "failed", resolvedAt: "2026-10-11T03:01:00.000Z" }),
			]);
			expect((await store.listOpen("yukarin", "c1")).map((o) => o.id)).toEqual([
				first.id,
				second.id,
			]);
		}));

	it("複数の操作を 1 回の save で保存できる", () =>
		withStore(async (store) => {
			const a = op();
			const b = op({ status: "cancelled", resolvedAt: a.createdAt });
			await store.save([a, b]);
			expect(await store.get("yukarin", a.id)).toEqual(a);
			expect(await store.get("yukarin", b.id)).toEqual(b);
		}));

	it("期限切れの保存: proposed を expired にして保存すると listOpen から外れる", () =>
		withStore(async (store) => {
			const saved = op();
			await store.save([saved]);
			await store.save([
				{ ...saved, status: "expired", resolvedAt: "2026-10-11T03:11:00.000Z" },
			]);
			expect(await store.listOpen("yukarin", "c1")).toEqual([]);
			expect((await store.get("yukarin", saved.id))?.status).toBe("expired");
		}));
});
