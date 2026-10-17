import { err, externalServiceUnavailable, ok } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import type {
	CallContext,
	CapabilityAdapter,
	CapabilityRequest,
	CapabilityResponse,
} from "./contract.ts";
import {
	calendarCreateEvent,
	calendarListEvents,
} from "./definitions/calendar.ts";
import {
	createCapabilityGate,
	type PendingStore,
	pendingCancelDefinition,
	pendingConfirmDefinition,
} from "./gate.ts";
import { PENDING_TTL_MS, type PendingOperation } from "./pending.ts";
import type { CapabilityPolicy } from "./policy.ts";
import { createToolRegistry } from "./registry.ts";

const T0 = new Date("2026-10-17T03:00:00.000Z");

const context = (over: Partial<CallContext> = {}): CallContext => ({
	partnerId: "yukarin",
	speakerId: "owner-1",
	isOwner: true,
	channelId: "ch-1",
	sourceMessageId: "msg-1",
	now: T0,
	...over,
});

const listInput = {
	from: "2026-10-18T00:00:00+09:00",
	to: "2026-10-19T00:00:00+09:00",
};
const createInput = {
	summary: "歯医者",
	start: "2026-10-18T19:00:00+09:00",
	end: "2026-10-18T20:00:00+09:00",
	description: null,
};

type Behavior = (
	request: CapabilityRequest,
) => ReturnType<CapabilityAdapter["execute"]>;

const fakeAdapter = (behavior?: Behavior) => {
	const calls: CapabilityRequest[] = [];
	const adapter: CapabilityAdapter = {
		tools: [calendarListEvents, calendarCreateEvent],
		execute: async (request) => {
			calls.push(request);
			if (behavior) return behavior(request);
			const response: CapabilityResponse = {
				data: { tool: request.tool },
				summary: `${request.tool} を実行`,
			};
			return ok(response);
		},
	};
	return { adapter, calls };
};

const memoryStore = (
	over: Partial<Record<keyof PendingStore, () => void>> = {},
) => {
	const ops = new Map<string, PendingOperation>();
	const store: PendingStore = {
		listOpen: async (partnerId, channelId) => {
			over.listOpen?.();
			return [...ops.values()].filter(
				(op) =>
					op.partnerId === partnerId &&
					op.channelId === channelId &&
					op.status === "proposed",
			);
		},
		get: async (partnerId, id) => {
			over.get?.();
			const op = ops.get(id);
			return op?.partnerId === partnerId ? op : null;
		},
		save: async (saved) => {
			over.save?.();
			for (const op of saved) ops.set(op.id, op);
		},
	};
	return { store, ops };
};

const setup = (
	opts: {
		behavior?: Behavior;
		policy?: CapabilityPolicy;
		store?: ReturnType<typeof memoryStore>;
		now?: () => Date;
	} = {},
) => {
	const { adapter, calls } = fakeAdapter(opts.behavior);
	const registry = createToolRegistry([adapter]);
	if (!registry.ok) throw new Error("登録簿を作れない");
	const pending = opts.store ?? memoryStore();
	const gate = createCapabilityGate({
		registry: registry.value,
		policy: opts.policy ?? { calendar_read: "auto", calendar_write: "confirm" },
		pending: pending.store,
		now: opts.now ?? (() => T0),
	});
	return { gate, calls, pending };
};

const body = (content: string) =>
	JSON.parse(content) as Record<string, unknown>;

const propose = async (
	gate: ReturnType<typeof setup>["gate"],
	over: Partial<CallContext> = {},
) => {
	const res = await gate.handle(
		{ name: "calendar_create_event", input: createInput },
		context(over),
	);
	return { res, id: String(body(res.content).pending_id) };
};

describe("definitions", () => {
	it("登録簿の定義に pending_confirm と pending_cancel を足し、順序は呼ぶたびに変わらない", () => {
		const { gate } = setup();
		const names = gate.definitions.map((d) => d.name);
		expect(names).toEqual([
			"calendar_list_events",
			"calendar_create_event",
			"pending_confirm",
			"pending_cancel",
		]);
		expect(gate.definitions).toBe(gate.definitions);
		expect(gate.definitions.slice(-2)).toEqual([
			pendingConfirmDefinition,
			pendingCancelDefinition,
		]);
	});
});

describe("registry の道具", () => {
	it("登録簿にない名前は unknown_tool", async () => {
		const { gate, calls } = setup();
		const res = await gate.handle({ name: "nope", input: {} }, context());
		expect(res.isError).toBe(true);
		expect(body(res.content)).toEqual({ status: "unknown_tool" });
		expect(res.record).toMatchObject({
			tool: "nope",
			decision: "unknown",
			pendingId: null,
		});
		expect(calls).toHaveLength(0);
	});

	it("入力が不正なら invalid_input と issues を返し、adapter は呼ばない", async () => {
		const { gate, calls } = setup();
		const res = await gate.handle(
			{ name: "calendar_list_events", input: { from: "あした", to: "x" } },
			context(),
		);
		expect(res.isError).toBe(true);
		const parsed = body(res.content);
		expect(parsed.status).toBe("invalid_input");
		expect(parsed.issues).toEqual(expect.arrayContaining([expect.any(String)]));
		expect(res.record.decision).toBe("invalid");
		expect(calls).toHaveLength(0);
	});

	it("オーナー以外は denied。入力が不正でも denied を先に返す", async () => {
		const { gate, calls, pending } = setup();
		const valid = await gate.handle(
			{ name: "calendar_list_events", input: listInput },
			context({ isOwner: false }),
		);
		expect(valid.isError).toBe(true);
		expect(body(valid.content)).toEqual({
			status: "denied",
			reason: "not_owner",
		});
		expect(valid.record).toMatchObject({
			decision: "deny",
			outcome: "denied",
			summary: "not_owner",
		});

		const invalid = await gate.handle(
			{ name: "calendar_create_event", input: {} },
			context({ isOwner: false }),
		);
		expect(body(invalid.content).status).toBe("denied");
		expect(calls).toHaveLength(0);
		expect(pending.ops.size).toBe(0);
	});

	it("policy が deny の category と、policy にない category は denied", async () => {
		const denied = setup({ policy: { calendar_read: "deny" } });
		const a = await denied.gate.handle(
			{ name: "calendar_list_events", input: listInput },
			context(),
		);
		expect(body(a.content)).toEqual({
			status: "denied",
			reason: "policy_deny",
		});

		const missing = setup({ policy: {} });
		const b = await missing.gate.handle(
			{ name: "calendar_list_events", input: listInput },
			context(),
		);
		expect(body(b.content)).toEqual({
			status: "denied",
			reason: "unknown_category",
		});
		expect(denied.calls).toHaveLength(0);
		expect(missing.calls).toHaveLength(0);
	});

	it("auto は adapter を実行して結果を返す", async () => {
		const { gate, calls } = setup();
		const res = await gate.handle(
			{ name: "calendar_list_events", input: listInput },
			context(),
		);
		expect(res.isError).toBe(false);
		expect(body(res.content)).toEqual({
			status: "ok",
			result: { tool: "calendar_list_events" },
		});
		expect(res.record).toMatchObject({
			tool: "calendar_list_events",
			decision: "auto",
			outcome: "ok",
			summary: "calendar_list_events を実行",
			pendingId: null,
		});
		expect(res.record.latencyMs).toBeGreaterThanOrEqual(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.requestId).toEqual(expect.any(String));
		expect(calls[0]?.input).toEqual(listInput);
		expect(calls[0]?.context.sourceMessageId).toBe("msg-1");
	});

	it("auto の失敗は error と retryable を返し、summary には型名だけを残す", async () => {
		const { gate } = setup({
			behavior: async () => err(externalServiceUnavailable({ service: "g" })),
		});
		const res = await gate.handle(
			{ name: "calendar_list_events", input: listInput },
			context(),
		);
		expect(res.isError).toBe(true);
		expect(body(res.content)).toEqual({
			status: "error",
			error: "ExternalServiceUnavailable",
			retryable: true,
		});
		expect(res.record).toMatchObject({
			decision: "auto",
			outcome: "error",
			summary: "ExternalServiceUnavailable",
		});
	});

	it("adapter が例外を投げても gate の外へ漏らさず、isError の結果にする", async () => {
		const { gate } = setup({
			behavior: async () => {
				throw new Error("secret=abc");
			},
		});
		const res = await gate.handle(
			{ name: "calendar_list_events", input: listInput },
			context(),
		);
		expect(res.isError).toBe(true);
		expect(body(res.content).status).toBe("error");
		expect(res.content).not.toContain("secret");
		expect(res.record.outcome).toBe("error");
	});

	it("confirm は adapter を呼ばずに保留にし、pending_id と期限を返す", async () => {
		const { gate, calls, pending } = setup();
		const { res, id } = await propose(gate);
		expect(res.isError).toBe(false);
		const parsed = body(res.content);
		expect(parsed).toMatchObject({
			status: "pending_confirmation",
			expires_at: new Date(T0.getTime() + PENDING_TTL_MS).toISOString(),
		});
		expect(parsed.note).toEqual(expect.stringContaining("pending_confirm"));
		expect(calls).toHaveLength(0);
		expect(pending.ops.get(id)).toMatchObject({
			status: "proposed",
			tool: "calendar_create_event",
			input: createInput,
			sourceMessageId: "msg-1",
			channelId: "ch-1",
		});
		expect(res.record).toMatchObject({
			decision: "confirm",
			outcome: "pending",
			pendingId: id,
		});
	});

	it("同じチャンネルの新しい提案は、古い保留を取り消す", async () => {
		const { gate, pending } = setup();
		const first = await propose(gate);
		const other = await propose(gate, { channelId: "ch-2" });
		const second = await propose(gate, { sourceMessageId: "msg-2" });
		expect(pending.ops.get(first.id)?.status).toBe("cancelled");
		expect(pending.ops.get(second.id)?.status).toBe("proposed");
		expect(pending.ops.get(other.id)?.status).toBe("proposed");
	});

	it("保留の保存に失敗したら isError で、gate の外へ漏らさない", async () => {
		const { gate } = setup({
			store: memoryStore({
				save: () => {
					throw new Error("db down");
				},
			}),
		});
		const { res } = await propose(gate);
		expect(res.isError).toBe(true);
		expect(res.record).toMatchObject({ decision: "confirm", outcome: "error" });
	});
});

describe("pending_confirm", () => {
	it("了承されたら元の依頼の発言 ID で adapter を実行し、保留を executed にする", async () => {
		const { gate, calls, pending } = setup();
		const { id } = await propose(gate, { sourceMessageId: "msg-1" });

		const res = await gate.handle(
			{ name: "pending_confirm", input: { pending_id: id } },
			context({ sourceMessageId: "msg-2" }),
		);
		expect(res.isError).toBe(false);
		expect(body(res.content)).toEqual({
			status: "executed",
			result: { tool: "calendar_create_event" },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			tool: "calendar_create_event",
			input: createInput,
		});
		expect(calls[0]?.context.sourceMessageId).toBe("msg-1");
		expect(pending.ops.get(id)).toMatchObject({
			status: "executed",
			resolvedAt: T0.toISOString(),
		});
		expect(res.record).toMatchObject({
			tool: "pending_confirm",
			decision: "pending_confirm",
			outcome: "ok",
			pendingId: id,
		});
	});

	it("実行が失敗したら isError で、保留は failed になる", async () => {
		const { gate, pending } = setup({
			behavior: async (request) =>
				request.tool === "calendar_create_event"
					? err(externalServiceUnavailable({ service: "g" }))
					: ok({ data: null, summary: "" }),
		});
		const { id } = await propose(gate);
		const res = await gate.handle(
			{ name: "pending_confirm", input: { pending_id: id } },
			context({ sourceMessageId: "msg-2" }),
		);
		expect(res.isError).toBe(true);
		expect(body(res.content)).toMatchObject({
			status: "error",
			error: "ExternalServiceUnavailable",
		});
		expect(pending.ops.get(id)?.status).toBe("failed");
		expect(res.record).toMatchObject({ outcome: "error", pendingId: id });
	});

	it("実行は済んだが保留の保存に失敗したときは、実行した結果に注記を添える", async () => {
		let failSaves = false;
		const { gate, calls } = setup({
			store: memoryStore({
				save: () => {
					if (failSaves) throw new Error("db down");
				},
			}),
		});
		const { id } = await propose(gate);
		failSaves = true;
		const res = await gate.handle(
			{ name: "pending_confirm", input: { pending_id: id } },
			context({ sourceMessageId: "msg-2" }),
		);
		expect(calls).toHaveLength(1);
		expect(res.isError).toBe(false);
		expect(body(res.content)).toMatchObject({
			status: "executed",
			note: expect.any(String),
		});
	});

	it("二度目の了承は rejected で、adapter は一度しか呼ばれない", async () => {
		const { gate, calls } = setup();
		const { id } = await propose(gate);
		const input = { pending_id: id };
		await gate.handle({ name: "pending_confirm", input }, context());
		const again = await gate.handle(
			{ name: "pending_confirm", input },
			context(),
		);
		expect(again.isError).toBe(true);
		expect(body(again.content)).toEqual({
			status: "rejected",
			reason: "InvalidStateTransition",
		});
		expect(calls).toHaveLength(1);
	});

	it("存在しない id と、別チャンネルの保留は not_found", async () => {
		const { gate, calls, pending } = setup();
		const { id } = await propose(gate, { channelId: "ch-2" });

		const missing = await gate.handle(
			{ name: "pending_confirm", input: { pending_id: "none" } },
			context(),
		);
		expect(body(missing.content)).toEqual({ status: "not_found" });
		expect(missing.isError).toBe(true);
		expect(missing.record.outcome).toBe("not_found");

		const crossChannel = await gate.handle(
			{ name: "pending_confirm", input: { pending_id: id } },
			context({ channelId: "ch-1" }),
		);
		expect(body(crossChannel.content)).toEqual({ status: "not_found" });
		expect(pending.ops.get(id)?.status).toBe("proposed");
		expect(calls).toHaveLength(0);
	});

	it("期限が切れていたら expired を保存し、実行しない", async () => {
		let now = T0;
		const { gate, calls, pending } = setup({ now: () => now });
		const { id } = await propose(gate);
		now = new Date(T0.getTime() + PENDING_TTL_MS);
		const res = await gate.handle(
			{ name: "pending_confirm", input: { pending_id: id } },
			context(),
		);
		expect(res.isError).toBe(true);
		expect(body(res.content).status).toBe("expired");
		expect(pending.ops.get(id)?.status).toBe("expired");
		expect(res.record).toMatchObject({ outcome: "expired", pendingId: id });
		expect(calls).toHaveLength(0);
	});

	it("オーナー以外は了承できない", async () => {
		const { gate, calls, pending } = setup();
		const { id } = await propose(gate);
		const res = await gate.handle(
			{ name: "pending_confirm", input: { pending_id: id } },
			context({ isOwner: false, speakerId: "guest" }),
		);
		expect(res.isError).toBe(true);
		expect(body(res.content)).toEqual({
			status: "denied",
			reason: "not_owner",
		});
		expect(res.record.outcome).toBe("denied");
		expect(pending.ops.get(id)?.status).toBe("proposed");
		expect(calls).toHaveLength(0);
	});

	it("入力が不正なら invalid_input", async () => {
		const { gate } = setup();
		const res = await gate.handle(
			{ name: "pending_confirm", input: {} },
			context(),
		);
		expect(res.isError).toBe(true);
		expect(body(res.content).status).toBe("invalid_input");
	});

	it("保留の元の道具が登録簿から無くなっていたら failed にする", async () => {
		const pending = memoryStore();
		const { gate } = setup({ store: pending });
		const { id } = await propose(gate);
		const empty = createToolRegistry([]);
		if (!empty.ok) throw new Error("登録簿を作れない");
		const later = createCapabilityGate({
			registry: empty.value,
			policy: {},
			pending: pending.store,
			now: () => T0,
		});
		const res = await later.handle(
			{ name: "pending_confirm", input: { pending_id: id } },
			context(),
		);
		expect(res.isError).toBe(true);
		expect(pending.ops.get(id)?.status).toBe("failed");
	});

	it("store が例外を投げても isError の結果にする", async () => {
		const { gate } = setup({
			store: memoryStore({
				get: () => {
					throw new Error("db down");
				},
			}),
		});
		const res = await gate.handle(
			{ name: "pending_confirm", input: { pending_id: "x" } },
			context(),
		);
		expect(res.isError).toBe(true);
		expect(res.record).toMatchObject({
			decision: "pending_confirm",
			outcome: "error",
		});
	});
});

describe("pending_cancel", () => {
	it("取り消して cancelled を返し、実行しない", async () => {
		const { gate, calls, pending } = setup();
		const { id } = await propose(gate);
		const res = await gate.handle(
			{ name: "pending_cancel", input: { pending_id: id } },
			context(),
		);
		expect(res.isError).toBe(false);
		expect(body(res.content)).toEqual({ status: "cancelled" });
		expect(pending.ops.get(id)).toMatchObject({
			status: "cancelled",
			resolvedAt: T0.toISOString(),
		});
		expect(res.record).toMatchObject({
			tool: "pending_cancel",
			decision: "pending_cancel",
			outcome: "cancelled",
			pendingId: id,
		});
		expect(calls).toHaveLength(0);
	});

	it("取り消したあとの了承は rejected", async () => {
		const { gate, calls } = setup();
		const { id } = await propose(gate);
		const input = { pending_id: id };
		await gate.handle({ name: "pending_cancel", input }, context());
		const res = await gate.handle(
			{ name: "pending_confirm", input },
			context(),
		);
		expect(body(res.content)).toEqual({
			status: "rejected",
			reason: "InvalidStateTransition",
		});
		expect(calls).toHaveLength(0);
	});

	it("存在しない id、別チャンネル、解決済みの保留は取り消せない", async () => {
		const { gate, pending } = setup();
		const other = await propose(gate, { channelId: "ch-2" });
		const missing = await gate.handle(
			{ name: "pending_cancel", input: { pending_id: "none" } },
			context(),
		);
		expect(body(missing.content)).toEqual({ status: "not_found" });
		const cross = await gate.handle(
			{ name: "pending_cancel", input: { pending_id: other.id } },
			context({ channelId: "ch-1" }),
		);
		expect(body(cross.content)).toEqual({ status: "not_found" });
		expect(pending.ops.get(other.id)?.status).toBe("proposed");

		const done = await propose(gate);
		const input = { pending_id: done.id };
		await gate.handle({ name: "pending_cancel", input }, context());
		const again = await gate.handle(
			{ name: "pending_cancel", input },
			context(),
		);
		expect(again.isError).toBe(true);
		expect(body(again.content).status).toBe("rejected");
	});

	it("オーナー以外は取り消せない", async () => {
		const { gate, pending } = setup();
		const { id } = await propose(gate);
		const res = await gate.handle(
			{ name: "pending_cancel", input: { pending_id: id } },
			context({ isOwner: false }),
		);
		expect(res.isError).toBe(true);
		expect(body(res.content)).toEqual({
			status: "denied",
			reason: "not_owner",
		});
		expect(pending.ops.get(id)?.status).toBe("proposed");
	});
});
