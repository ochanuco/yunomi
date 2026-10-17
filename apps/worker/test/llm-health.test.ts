import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TurnResponse } from "@yunomi/conversation";
import { validationFailed } from "@yunomi/core";
import { FakeLLMProvider, HAIKU, ModelRouter } from "@yunomi/llm";
import { describe, expect, it } from "vitest";
import { inbound, partnerStub } from "./helpers.ts";

const BOT = env.PARTNER_DISCORD_USER_ID;
const T0 = new Date("2026-10-11T03:00:00Z");

const response: TurnResponse = {
	messages: ["はい"],
	reply_policy: "reply",
	decision_summary: "返事する",
	emotion_delta: { mood: 0, energy: 0 },
	relationship_delta: { familiarity: 0, trust: 0 },
	interest_signals: [],
	opinion_signals: [],
	memory_candidates: [],
	open_loops: [],
	resolved_open_loop_ids: [],
	performance: {
		emotion: "neutral",
		energy: 0.5,
		pace: "normal",
		warmth: 0.5,
		pause_before_ms: 0,
	},
	speak_aloud: false,
	voice_channel: "stay",
	needs_review: false,
};

const OK = {
	ok: true as const,
	value: {
		output: response,
		model: HAIKU,
		usage: {
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
		latencyMs: 1,
		stopReason: "end_turn",
	},
};
// 一時的な失敗は Haiku での再試行が台本を消費するため、再試行されない失敗を使う。
const FAIL = {
	ok: false as const,
	error: validationFailed({ issues: ["bad output"] }),
};

// "S" は成功、"F" は失敗。台本の順に LLM が応答する。
const run = async (name: string, script: string) => {
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider(
		[...script].map((c) => (c === "S" ? OK : FAIL)),
	);
	await runInDurableObject(stub, (o) => {
		o.now = () => T0;
		o.createRouter = () => new ModelRouter({ provider: fake });
	});
	const results = [];
	for (let i = 0; i < script.length; i++) {
		const msg = inbound({
			mentionedUserIds: [BOT],
			content: "やあ",
			author: { id: `u-${name}`, displayName: "alice", isBot: false },
		});
		results.push(await stub.handleDiscordMessage(msg));
		await stub.flushBackground();
	}
	return { stub, results };
};

const health = (stub: ReturnType<typeof partnerStub>) =>
	runInDurableObject(stub, (_o, s) => {
		const sql = s.storage.sql;
		const st = sql
			.exec<{ system_stress: number; degraded_mode: number; version: number }>(
				"SELECT system_stress, degraded_mode, version FROM partner_state",
			)
			.one();
		const streak = sql
			.exec<{ failure_streak: number }>("SELECT failure_streak FROM llm_health")
			.one().failure_streak;
		return {
			stress: st.system_stress,
			degraded: st.degraded_mode === 1,
			streak,
		};
	});

describe("LLM 障害による degradedMode / systemStress", () => {
	it("2 回の失敗では立たない", async () => {
		const { stub } = await run("health-two", "FF");
		expect(await health(stub)).toEqual({
			stress: 0,
			degraded: false,
			streak: 2,
		});
	});

	it("3 回の連続失敗で立ち、stress が +0.2、そのターンの audit に残る", async () => {
		const { stub, results } = await run("health-three", "FFF");
		const h = await health(stub);
		expect(h).toMatchObject({ degraded: true, streak: 3 });
		expect(h.stress).toBeCloseTo(0.2);
		expect(results.map((r) => r.audit.degradedTransition)).toEqual([
			null,
			null,
			"entered",
		]);
		expect(results.every((r) => r.audit.degraded)).toBe(true);
	});

	it("degradedMode 中の失敗は 1 回ごとに +0.1", async () => {
		const { stub } = await run("health-more", "FFFFF");
		expect((await health(stub)).stress).toBeCloseTo(0.4);
	});

	it("成功で戻り、stress は -0.1 ずつ下限 0 まで下がる", async () => {
		const { stub, results } = await run("health-recover", "FFFSSS");
		const h = await health(stub);
		expect(h).toEqual({ stress: 0, degraded: false, streak: 0 });
		expect(results.map((r) => r.audit.degradedTransition)).toEqual([
			null,
			null,
			"entered",
			"recovered",
			null,
			null,
		]);
	});

	it("成功を挟むと連続失敗のカウンタがリセットされる", async () => {
		const { stub } = await run("health-reset", "FFSFF");
		expect(await health(stub)).toEqual({
			stress: 0,
			degraded: false,
			streak: 2,
		});
	});

	it("stress は 1.0 を超えない", async () => {
		const { stub } = await run("health-cap", "F".repeat(12));
		expect((await health(stub)).stress).toBe(1);
	});

	it("連続失敗カウンタは DO を作り直しても持ち越される", async () => {
		const { stub } = await run("health-persist", "FF");
		const { evictDurableObject } = await import("cloudflare:test");
		await evictDurableObject(stub);
		expect((await health(partnerStub("health-persist"))).streak).toBe(2);
	});

	it("遷移は理由付きで state_transitions に残る", async () => {
		const { results } = await run("health-history", "FFFS");
		const reasons = async (eventId: string) =>
			(
				await env.DB.prepare(
					"SELECT reason, before_json, after_json FROM state_transitions WHERE source_event_id = ?",
				)
					.bind(eventId)
					.all<{ reason: string; before_json: string; after_json: string }>()
			).results;
		const ids = results.map((r) => r.audit.inbound.eventId);
		expect(await reasons(ids[0] as string)).toEqual([]);
		expect(await reasons(ids[1] as string)).toEqual([]);
		const [entered] = await reasons(ids[2] as string);
		expect(entered?.reason).toBe("llm_consecutive_failures");
		expect(JSON.parse(entered?.before_json ?? "{}").degradedMode).toBe(false);
		expect(JSON.parse(entered?.after_json ?? "{}")).toMatchObject({
			degradedMode: true,
			systemStress: 0.2,
		});
		const [recovered] = await reasons(ids[3] as string);
		expect(recovered?.reason).toBe("llm_recovered");
		expect(JSON.parse(recovered?.after_json ?? "{}")).toMatchObject({
			degradedMode: false,
			systemStress: 0.1,
		});
	});
});
