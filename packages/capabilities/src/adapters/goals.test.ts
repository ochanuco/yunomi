import { err, ok } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import type { CallContext } from "../contract.ts";
import { createGoalAdapter, type GoalStore } from "./goals.ts";

const context: CallContext = {
	partnerId: "partner-1",
	speakerId: "owner-1",
	isOwner: true,
	channelId: "channel-1",
	sourceMessageId: "1234567890123456789",
	now: new Date("2026-11-06T03:00:00Z"),
};

const setup = (store: Partial<GoalStore>) => {
	const calls: unknown[] = [];
	const full: GoalStore = {
		add: async (input) => {
			calls.push(input);
			return ok({ id: "g1", summary: input.summary });
		},
		close: async (input) => {
			calls.push(input);
			return ok({ id: input.id, summary: "英語で発表する" });
		},
		...store,
	};
	return { adapter: createGoalAdapter({ store: full }), calls };
};

const run = (
	adapter: ReturnType<typeof setup>["adapter"],
	tool: string,
	input: unknown,
) => adapter.execute({ requestId: "r1", tool, input, context });

describe("goal adapter", () => {
	it("goal_add は話し手の目標として 1 行で足す", async () => {
		const { adapter, calls } = setup({});
		const r = await run(adapter, "goal_add", { summary: "  英語で発表する " });
		expect(r).toEqual(
			ok({
				data: { status: "added", id: "g1", summary: "英語で発表する" },
				summary: "目標を 1 件足した",
			}),
		);
		expect(calls).toEqual([
			{
				partnerId: "partner-1",
				discordUserId: "owner-1",
				summary: "英語で発表する",
				now: context.now,
			},
		]);
	});

	it("改行や空の目標は検証で落とす", async () => {
		const { adapter, calls } = setup({});
		for (const summary of ["1行目\n2行目", "  ", "あ".repeat(201)]) {
			const r = await run(adapter, "goal_add", { summary });
			expect(r.ok).toBe(false);
		}
		expect(calls).toEqual([]);
	});

	it("goal_close は達成か取り下げで閉じる", async () => {
		const { adapter, calls } = setup({});
		const r = await run(adapter, "goal_close", {
			id: "g1",
			status: "achieved",
		});
		expect(r.ok && r.value.data).toEqual({
			status: "achieved",
			id: "g1",
			summary: "英語で発表する",
		});
		expect(calls).toHaveLength(1);
		expect(
			(await run(adapter, "goal_close", { id: "g1", status: "done" })).ok,
		).toBe(false);
	});

	it("重複・上限・見つからないはモデルが言い分けられるよう data で返す", async () => {
		const { adapter } = setup({
			add: async () => err({ type: "limit" }),
			close: async () => err({ type: "not_found" }),
		});
		const added = await run(adapter, "goal_add", { summary: "走る" });
		expect(added.ok && added.value.data).toMatchObject({
			status: "not_done",
			reason: "limit",
		});
		const closed = await run(adapter, "goal_close", {
			id: "x",
			status: "dropped",
		});
		expect(closed.ok && closed.value.data).toMatchObject({
			status: "not_done",
			reason: "not_found",
		});
	});

	it("置き場所に届かなければ失敗にする", async () => {
		const { adapter } = setup({
			add: async () => err({ type: "unavailable" }),
		});
		const r = await run(adapter, "goal_add", { summary: "走る" });
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
	});
});
