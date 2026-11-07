import { err, ok } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import type { CallContext } from "../contract.ts";
import { createWatchAdapter, type WatchStore } from "./watches.ts";

const context: CallContext = {
	partnerId: "partner-1",
	speakerId: "owner-1",
	isOwner: true,
	channelId: "channel-1",
	sourceMessageId: "1234567890123456789",
	now: new Date("2026-11-06T03:00:00Z"),
};

const setup = (store: Partial<WatchStore> = {}) => {
	const calls: Parameters<WatchStore["add"]>[0][] = [];
	const full: WatchStore = {
		add: async (input) => {
			calls.push(input);
			return ok({ id: "w1" });
		},
		stop: async (input) => ok({ id: input.id, query: "q" }),
		...store,
	};
	return { adapter: createWatchAdapter({ store: full }), calls };
};

const run = (
	adapter: ReturnType<typeof setup>["adapter"],
	tool: string,
	input: unknown,
) => adapter.execute({ requestId: "r1", tool, input, context });

const input = {
	query: " RTX3090 の中古、24GB ",
	sources: ["じゃんぱら", "https://shop.example/gpu"],
	interval_hours: 6,
	until: "2026-12-31T23:59:00+09:00",
};

describe("watch adapter", () => {
	it("watch_add は間隔を分に、期限を Date にして話し手の見張りとして書く", async () => {
		const { adapter, calls } = setup();
		const r = await run(adapter, "watch_add", input);
		expect(r.ok && r.value.data).toMatchObject({ status: "added", id: "w1" });
		expect(calls).toEqual([
			{
				partnerId: "partner-1",
				discordUserId: "owner-1",
				query: "RTX3090 の中古、24GB",
				sources: ["じゃんぱら", "https://shop.example/gpu"],
				intervalMinutes: 360,
				schedule: null,
				untilAt: new Date("2026-12-31T14:59:00Z"),
				now: context.now,
			},
		]);
	});

	it("cron 式は間隔を null にして書き、どちらも無ければ 24 時間おきにする", async () => {
		const { adapter, calls } = setup();
		await run(adapter, "watch_add", {
			...input,
			interval_hours: null,
			schedule: "0 9-18 * * 1-5",
		});
		await run(adapter, "watch_add", {
			...input,
			interval_hours: null,
			schedule: null,
		});
		const { interval_hours: _i, ...omitted } = input;
		await run(adapter, "watch_add", omitted);
		expect(calls.map((c) => [c.intervalMinutes, c.schedule])).toEqual([
			[null, "0 9-18 * * 1-5"],
			[1440, null],
			[1440, null],
		]);
	});

	it("間隔と cron 式の両方、5 項目でない式、30 分より詰めた式は書かずに落とす", async () => {
		const { adapter, calls } = setup();
		const results = await Promise.all(
			[
				{ ...input, schedule: "0 9-18 * * 1-5" },
				{ ...input, interval_hours: null, schedule: "0 0 9 * * 1-5" },
				{ ...input, interval_hours: null, schedule: "@hourly" },
				{ ...input, interval_hours: null, schedule: "*/15 9-18 * * *" },
			].map((bad) => run(adapter, "watch_add", bad)),
		);
		expect(
			results.map((r) =>
				!r.ok && r.error.type === "ValidationFailed" ? r.error.issues : r,
			),
		).toEqual([
			["schedule: interval_hours と一緒には指定できない"],
			["schedule: 5 項目（分 時 日 月 曜日）の数字と * , - / だけで書く"],
			["schedule: 5 項目（分 時 日 月 曜日）の数字と * , - / だけで書く"],
			["schedule: 30 分より短い間隔で動く"],
		]);
		expect(calls).toEqual([]);
	});

	it("オフセットの無い期限は JST として読み、期限なしは null", async () => {
		const { adapter, calls } = setup();
		await run(adapter, "watch_add", { ...input, until: "2026-12-01T00:00:00" });
		await run(adapter, "watch_add", { ...input, until: null });
		expect(calls.map((c) => c.untilAt)).toEqual([
			new Date("2026-11-30T15:00:00Z"),
			null,
		]);
	});

	it("間隔・場所の数・期限の誤りは書かずに落とす", async () => {
		const { adapter, calls } = setup();
		for (const bad of [
			{ ...input, interval_hours: 0 },
			{ ...input, interval_hours: 24 * 7 + 1 },
			{ ...input, sources: ["a", "b", "c", "d", "e", "f"] },
			{ ...input, until: "来週" },
			{ ...input, until: "2026-11-01T00:00:00+09:00" },
			{ ...input, query: "1行目\n2行目" },
		]) {
			expect((await run(adapter, "watch_add", bad)).ok).toBe(false);
		}
		expect(calls).toEqual([]);
	});

	it("重複・上限・見つからないは data で返し、届かなければ失敗にする", async () => {
		const { adapter } = setup({
			add: async () => err({ type: "duplicate" }),
			stop: async () => err({ type: "not_found" }),
		});
		const added = await run(adapter, "watch_add", input);
		expect(added.ok && added.value.data).toMatchObject({
			status: "not_done",
			reason: "duplicate",
		});
		const stopped = await run(adapter, "watch_stop", { id: "x" });
		expect(stopped.ok && stopped.value.data).toMatchObject({
			reason: "not_found",
		});
		const down = setup({ stop: async () => err({ type: "unavailable" }) });
		const r = await run(down.adapter, "watch_stop", { id: "x" });
		expect(!r.ok && r.error.type).toBe("ExternalServiceUnavailable");
	});
});
