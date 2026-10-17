import { describe, expect, it } from "vitest";
import type { CallContext, CapabilityRequest } from "./contract.ts";
import {
	cancel,
	complete,
	confirm,
	expireDue,
	PENDING_TTL_MS,
	type PendingOperation,
	propose,
} from "./pending.ts";

const now = new Date("2026-10-17T03:00:00.000Z");
const later = (ms: number): Date => new Date(now.getTime() + ms);

const context = (overrides: Partial<CallContext> = {}): CallContext => ({
	partnerId: "yukarin",
	speakerId: "owner-1",
	isOwner: true,
	channelId: "ch-1",
	sourceMessageId: "msg-1",
	now,
	...overrides,
});

const request = (overrides: Partial<CallContext> = {}): CapabilityRequest => ({
	requestId: "req-1",
	tool: "calendar_create_event",
	input: { title: "歯医者" },
	context: context(overrides),
});

const op = (overrides: Partial<PendingOperation> = {}): PendingOperation => ({
	id: "op-1",
	partnerId: "yukarin",
	channelId: "ch-1",
	tool: "calendar_create_event",
	input: { title: "歯医者" },
	requestedBy: "owner-1",
	sourceMessageId: "msg-1",
	createdAt: now.toISOString(),
	expiresAt: later(PENDING_TTL_MS).toISOString(),
	status: "proposed",
	resolvedAt: null,
	...overrides,
});

const owner = { isOwner: true };
const guest = { isOwner: false };

describe("propose", () => {
	it("request の内容を写し、期限を now + TTL にした proposed を作る", () => {
		const { created, superseded } = propose(request(), [], now);
		expect(created).toMatchObject({
			partnerId: "yukarin",
			channelId: "ch-1",
			tool: "calendar_create_event",
			input: { title: "歯医者" },
			requestedBy: "owner-1",
			sourceMessageId: "msg-1",
			createdAt: "2026-10-17T03:00:00.000Z",
			expiresAt: "2026-10-17T03:10:00.000Z",
			status: "proposed",
			resolvedAt: null,
		});
		expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(superseded).toEqual([]);
	});

	it("同じ partner・同じチャンネルの proposed は cancelled にして superseded に入れる", () => {
		const old = op({ id: "old" });
		const { created, superseded } = propose(request(), [old], later(1000));
		expect(superseded).toEqual([
			{
				...old,
				status: "cancelled",
				resolvedAt: "2026-10-17T03:00:01.000Z",
			},
		]);
		expect(created.id).not.toBe("old");
	});

	it("別チャンネルや別 partner の保留は残る", () => {
		const otherChannel = op({ id: "a", channelId: "ch-2" });
		const otherPartner = op({ id: "b", partnerId: "someone" });
		const { superseded } = propose(
			request(),
			[otherChannel, otherPartner],
			now,
		);
		expect(superseded).toEqual([]);
	});

	it("proposed でない保留は取り消し対象にしない", () => {
		const executed = op({ id: "a", status: "executed", resolvedAt: "x" });
		const { superseded } = propose(request(), [executed], now);
		expect(superseded).toEqual([]);
	});

	it("渡した open を書き換えない", () => {
		const old = op({ id: "old" });
		propose(request(), [old], now);
		expect(old.status).toBe("proposed");
		expect(old.resolvedAt).toBeNull();
	});
});

describe("confirm", () => {
	it("オーナーが期限内に了承すると ready で、op は proposed のまま", () => {
		const target = op();
		expect(confirm(target, owner, later(1000))).toEqual({
			type: "ready",
			op: target,
		});
	});

	it("期限を過ぎていれば expired の op を返す", () => {
		const result = confirm(op(), owner, later(PENDING_TTL_MS + 1));
		expect(result).toEqual({
			type: "expired",
			op: {
				...op(),
				status: "expired",
				resolvedAt: later(PENDING_TTL_MS + 1).toISOString(),
			},
		});
	});

	it("期限の 1ms 前は ready、ちょうどは expired", () => {
		expect(confirm(op(), owner, later(PENDING_TTL_MS - 1)).type).toBe("ready");
		expect(confirm(op(), owner, later(PENDING_TTL_MS)).type).toBe("expired");
	});

	it("オーナー以外は PermissionDenied で rejected", () => {
		const result = confirm(op(), guest, later(1000));
		expect(result.type).toBe("rejected");
		if (result.type === "rejected") {
			expect(result.error.type).toBe("PermissionDenied");
		}
	});

	it("proposed でなければ InvalidStateTransition で rejected", () => {
		for (const status of [
			"executed",
			"failed",
			"cancelled",
			"expired",
		] as const) {
			const result = confirm(op({ status, resolvedAt: "x" }), owner, now);
			expect(result.type).toBe("rejected");
			if (result.type === "rejected") {
				expect(result.error).toMatchObject({
					type: "InvalidStateTransition",
					from: status,
				});
			}
		}
	});

	it("オーナー以外かつ proposed でないときは状態遷移の拒否が先に出る", () => {
		const result = confirm(
			op({ status: "cancelled", resolvedAt: "x" }),
			guest,
			now,
		);
		expect(result.type === "rejected" && result.error.type).toBe(
			"InvalidStateTransition",
		);
	});

	it("オーナー以外は期限切れでも expired にせず rejected", () => {
		const result = confirm(op(), guest, later(PENDING_TTL_MS + 1));
		expect(result.type).toBe("rejected");
	});
});

describe("complete", () => {
	it("proposed を executed にして resolvedAt を入れる", () => {
		const result = complete(op(), "executed", later(2000));
		expect(result).toEqual({
			ok: true,
			value: {
				...op(),
				status: "executed",
				resolvedAt: "2026-10-17T03:00:02.000Z",
			},
		});
	});

	it("proposed を failed にできる", () => {
		const result = complete(op(), "failed", later(2000));
		expect(result.ok && result.value.status).toBe("failed");
	});

	it("proposed 以外からは InvalidStateTransition", () => {
		for (const status of [
			"executed",
			"failed",
			"cancelled",
			"expired",
		] as const) {
			const result = complete(op({ status, resolvedAt: "x" }), "executed", now);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toMatchObject({
					type: "InvalidStateTransition",
					from: status,
					to: "executed",
				});
			}
		}
	});
});

describe("cancel", () => {
	it("proposed を cancelled にして resolvedAt を入れる", () => {
		const result = cancel(op(), later(3000));
		expect(result).toEqual({
			ok: true,
			value: {
				...op(),
				status: "cancelled",
				resolvedAt: "2026-10-17T03:00:03.000Z",
			},
		});
	});

	it("proposed 以外からは InvalidStateTransition", () => {
		for (const status of [
			"executed",
			"failed",
			"cancelled",
			"expired",
		] as const) {
			const result = cancel(op({ status, resolvedAt: "x" }), now);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toMatchObject({
					type: "InvalidStateTransition",
					from: status,
					to: "cancelled",
				});
			}
		}
	});
});

describe("expireDue", () => {
	it("期限を過ぎた proposed だけを expired にして返す", () => {
		const due = op({ id: "due", expiresAt: later(-1).toISOString() });
		const atBoundary = op({ id: "boundary", expiresAt: now.toISOString() });
		const alive = op({ id: "alive", expiresAt: later(1).toISOString() });
		const done = op({
			id: "done",
			status: "executed",
			resolvedAt: "x",
			expiresAt: later(-1).toISOString(),
		});
		expect(expireDue([due, atBoundary, alive, done], now)).toEqual([
			{ ...due, status: "expired", resolvedAt: now.toISOString() },
			{ ...atBoundary, status: "expired", resolvedAt: now.toISOString() },
		]);
	});

	it("該当が無ければ空", () => {
		expect(expireDue([op()], now)).toEqual([]);
		expect(expireDue([], now)).toEqual([]);
	});
});
