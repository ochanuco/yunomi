import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	FakeLLMProvider,
	HAIKU,
	type LLMResult,
	ModelRouter,
} from "@yunomi/llm";
import { dedupeKey } from "@yunomi/protocol";
import { describe, expect, it } from "vitest";
import {
	AUDIT_RETENTION_DAYS,
	auditCutoff,
	toAuditRow,
} from "../src/audit-store.ts";
import worker from "../src/index.ts";
import { inbound, partnerStub } from "./helpers.ts";

const BOT = env.PARTNER_DISCORD_USER_ID;
const NOW = new Date("2026-10-11T03:00:00Z");

type AuditRow = {
	id: string;
	event_id: string;
	dedupe_key: string;
	decision: string;
	reason: string;
	model: string | null;
	fallback_used: number;
	degraded: number;
	error_type: string | null;
	input_tokens: number;
	cache_read_tokens: number;
	inbound_content: string;
	detail_json: string;
	created_at: string;
};

const auditRows = (partnerId: string) =>
	env.DB.prepare(
		"SELECT * FROM audit_events WHERE partner_id = ? ORDER BY created_at, id",
	)
		.bind(partnerId)
		.all<AuditRow>()
		.then((r) => r.results);

const turnJson = (utterance: string, policy = "reply") => ({
	utterance,
	reply_policy: policy,
	decision_summary: "テスト",
	emotion_delta: { mood: 0, energy: 0 },
	relationship_delta: { familiarity: 0.01, trust: 0 },
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
});

const setup = async (name: string, outputs: unknown[]) => {
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider();
	for (const output of outputs) {
		fake.enqueue({
			ok: true,
			value: {
				output,
				model: HAIKU,
				usage: {
					inputTokens: 100,
					outputTokens: 20,
					cacheReadTokens: 5,
					cacheWriteTokens: 0,
				},
				latencyMs: 12,
				stopReason: "end_turn",
			} satisfies LLMResult<unknown>,
		});
	}
	await runInDurableObject(stub, (o) => {
		o.now = () => NOW;
		o.createRouter = () => new ModelRouter({ provider: fake });
	});
	return stub;
};

describe("audit_events", () => {
	it("LLM が reply したターンは 1 件記録され、本文と token を持つ", async () => {
		const stub = await setup("audit-reply", [turnJson("やあ")]);
		const msg = inbound({
			partnerId: "audit-reply",
			mentionedUserIds: [BOT],
			content: "ゆかりん、やあ",
		});
		await stub.handleDiscordMessage(msg);
		await stub.flushBackground();

		const rows = await auditRows("audit-reply");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			event_id: msg.eventId,
			dedupe_key: dedupeKey(msg),
			decision: "reply",
			reason: "llm",
			model: HAIKU,
			fallback_used: 0,
			degraded: 0,
			input_tokens: 100,
			cache_read_tokens: 5,
			inbound_content: "ゆかりん、やあ",
			created_at: NOW.toISOString(),
		});
		expect(JSON.parse(rows[0]?.detail_json ?? "{}")).toMatchObject({
			relationship: { applied: { familiarity: 0.01 } },
			toolCalls: [],
		});
	});

	it("LLM を呼ばない ignore も 1 件記録される", async () => {
		const stub = await setup("audit-ignore", []);
		await stub.handleDiscordMessage(
			inbound({
				partnerId: "audit-ignore",
				content: "雑談",
				mentionedUserIds: ["someone-else"],
			}),
		);
		await stub.flushBackground();

		const rows = await auditRows("audit-ignore");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			decision: "ignore",
			reason: "addressed_to_other",
			model: null,
			input_tokens: 0,
		});
	});

	it("同じイベントの再送では増えない", async () => {
		const stub = await setup("audit-dup", []);
		const msg = inbound({ partnerId: "audit-dup" });
		await stub.handleDiscordMessage(msg);
		await stub.handleDiscordMessage(msg);
		await stub.flushBackground();
		expect(await auditRows("audit-dup")).toHaveLength(1);
	});

	it("自己発言は記録しない", async () => {
		const stub = await setup("audit-self", []);
		await stub.handleDiscordMessage(
			inbound({
				partnerId: "audit-self",
				author: { id: BOT, displayName: "ゆかりん", isBot: true },
			}),
		);
		await stub.flushBackground();
		expect(await auditRows("audit-self")).toHaveLength(0);
	});
});

describe("保持期間", () => {
	it("cutoff は 30 日前", () => {
		expect(AUDIT_RETENTION_DAYS).toBe(30);
		expect(auditCutoff(new Date("2026-10-31T00:00:00Z")).toISOString()).toBe(
			"2026-10-01T00:00:00.000Z",
		);
	});

	it("toAuditRow は思考過程に当たるフィールドを持たない", () => {
		const row = toAuditRow(
			{ partnerId: "p", dedupeKey: "k", now: NOW, occurredAt: NOW },
			{
				inbound: {
					eventId: "e",
					messageId: "m",
					channelId: "c",
					authorId: "a",
					authorName: "n",
					isBot: false,
					contentLength: 1,
					content: "x",
				},
				decision: "ignore",
				reason: "bot",
				decisionSummary: null,
				model: null,
				fallbackUsed: false,
				degraded: false,
				usage: null,
				latencyMs: null,
				errorType: null,
				toolCalls: [],
				state: null,
				relationship: null,
				memory: null,
				openLoops: null,
				interestOpinion: null,
				degradedTransition: null,
			},
		);
		expect(Object.keys(row).join()).not.toMatch(/reasoning|thinking|thought/i);
	});

	it("cron は 30 日を過ぎた行だけを削除する", async () => {
		const stub = await setup("audit-cron", []);
		await stub.handleDiscordMessage(inbound({ partnerId: "audit-cron" }));
		await stub.flushBackground();
		const [row] = await auditRows("audit-cron");
		const base = row?.created_at ?? "";
		await env.DB.prepare(
			"INSERT INTO audit_events SELECT ?1, partner_id, event_id, dedupe_key, channel_id, author_entity_id, kind, decision, reason, decision_summary, model, fallback_used, degraded, error_type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms, inbound_content, detail_json, occurred_at, ?2 FROM audit_events WHERE id = ?3",
		)
			.bind("old-1", "2026-09-10T02:59:59.000Z", row?.id)
			.run();
		expect(base).toBe(NOW.toISOString());

		await worker.scheduled(
			{ scheduledTime: NOW.getTime(), cron: "17 19 * * *", noRetry() {} },
			env,
		);

		const ids = (await auditRows("audit-cron")).map((r) => r.id);
		expect(ids).toEqual([row?.id]);
	});
});
