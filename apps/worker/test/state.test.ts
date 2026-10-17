import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TurnResponse } from "@yunomi/conversation";
import { FakeLLMProvider, HAIKU, ModelRouter } from "@yunomi/llm";
import { describe, expect, it } from "vitest";
import { inbound, partnerStub } from "./helpers.ts";

const BOT = env.PARTNER_DISCORD_USER_ID;
const T0 = new Date("2026-10-11T03:00:00Z");

const response = (over: Partial<TurnResponse> = {}): TurnResponse => ({
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
	...over,
});

const ok = (output: TurnResponse) => ({
	ok: true as const,
	value: {
		output,
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
});

const setup = async (name: string, script: TurnResponse[]) => {
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider(script.map(ok));
	await runInDurableObject(stub, (o) => {
		o.now = () => T0;
		o.createRouter = () => new ModelRouter({ provider: fake });
	});
	return { stub, fake };
};

const mention = (over = {}) =>
	inbound({ mentionedUserIds: [BOT], content: "やあ", ...over });

const doState = (stub: ReturnType<typeof partnerStub>) =>
	runInDurableObject(stub, (_o, s) =>
		s.storage.sql
			.exec<{ mood: number; energy: number; version: number }>(
				"SELECT mood, energy, version FROM partner_state",
			)
			.one(),
	);

const doRelationships = (stub: ReturnType<typeof partnerStub>) =>
	runInDurableObject(stub, (_o, s) =>
		s.storage.sql
			.exec<{ entity_id: string; familiarity: number; trust: number }>(
				"SELECT entity_id, familiarity, trust FROM relationships",
			)
			.toArray(),
	);

describe("State / Relationship の更新", () => {
	it("bounded に適用し、DO に現在値・D1 に履歴を残す", async () => {
		const { stub } = await setup("state-apply", [
			response({
				emotion_delta: { mood: 0.9, energy: -0.05 },
				relationship_delta: { familiarity: 0.5, trust: -0.5 },
			}),
		]);
		const msg = mention({
			author: { id: "u-apply", displayName: "alice", isBot: false },
		});
		const res = await stub.handleDiscordMessage(msg);
		await stub.flushBackground();

		expect(res.audit.state?.applied).toEqual({ mood: 0.15, energy: -0.05 });
		expect(res.audit.relationship?.applied).toEqual({
			familiarity: 0.02,
			trust: -0.05,
		});

		const s = await doState(stub);
		expect(s.mood).toBeCloseTo(0.35);
		expect(s.energy).toBeCloseTo(0.55);
		expect(s.version).toBe(2);
		const [rel] = await doRelationships(stub);
		expect(rel?.familiarity).toBeCloseTo(0.42);
		expect(rel?.trust).toBeCloseTo(0.45);

		const transitions = await env.DB.prepare(
			"SELECT * FROM state_transitions WHERE source_event_id = ?",
		)
			.bind(msg.eventId)
			.all<{ before_json: string; after_json: string; delta_json: string }>();
		expect(transitions.results).toHaveLength(1);
		const row = transitions.results[0];
		expect(JSON.parse(row?.before_json ?? "{}").mood).toBe(0.2);
		expect(JSON.parse(row?.after_json ?? "{}").mood).toBeCloseTo(0.35);
		expect(JSON.parse(row?.delta_json ?? "{}")).toEqual({
			mood: 0.15,
			energy: -0.05,
		});

		const events = await env.DB.prepare(
			"SELECT * FROM relationship_events WHERE entity_id = ?",
		)
			.bind(rel?.entity_id)
			.all<{
				familiarity_delta: number;
				trust_delta: number;
				closeness_delta: null;
			}>();
		expect(events.results).toHaveLength(1);
		expect(events.results[0]).toMatchObject({
			familiarity_delta: 0.02,
			trust_delta: -0.05,
			closeness_delta: null,
		});
	});

	it("delta が 0 なら D1 に履歴を書かない", async () => {
		const { stub } = await setup("state-zero", [response()]);
		await stub.handleDiscordMessage(
			mention({ author: { id: "u-zero", displayName: "zed", isBot: false } }),
		);
		await stub.flushBackground();
		const [rel] = await doRelationships(stub);
		const events = await env.DB.prepare(
			"SELECT count(*) AS n FROM relationship_events WHERE entity_id = ?",
		)
			.bind(rel?.entity_id)
			.first<{ n: number }>();
		expect(events?.n).toBe(0);
		expect((await doState(stub)).version).toBe(1);
	});

	it("異常な delta は棄却して audit に残し、値を変えない", async () => {
		const { stub } = await setup("state-reject", [
			response({
				emotion_delta: { mood: 7, energy: 0 },
				relationship_delta: { familiarity: -3, trust: 0 },
			}),
		]);
		const res = await stub.handleDiscordMessage(
			mention({ author: { id: "u-rej", displayName: "rej", isBot: false } }),
		);
		expect(res.action).toBe("reply");
		expect(res.audit.state?.rejected[0]?.type).toBe(
			"RelationshipUpdateRejected",
		);
		expect(res.audit.relationship?.rejected[0]?.type).toBe(
			"RelationshipUpdateRejected",
		);
		expect((await doState(stub)).mood).toBeCloseTo(0.2);
	});

	it("DO を作り直しても値が戻り、次のプロンプトに反映される", async () => {
		const { stub } = await setup("state-evict", [
			response({
				emotion_delta: { mood: 0.1, energy: 0 },
				relationship_delta: { familiarity: 0.02, trust: 0.02 },
			}),
		]);
		const author = { id: "u-evict", displayName: "eve", isBot: false };
		await stub.handleDiscordMessage(mention({ author }));
		await stub.flushBackground();
		await evictDurableObject(stub);

		const fresh = partnerStub("state-evict");
		expect((await doState(fresh)).mood).toBeCloseTo(0.3);

		const fake = new FakeLLMProvider([ok(response())]);
		await runInDurableObject(fresh, (o) => {
			o.now = () => T0;
			o.createRouter = () => new ModelRouter({ provider: fake });
		});
		await fresh.handleDiscordMessage(mention({ author }));
		const system = fake.requests[0]?.system.map((b) => b.text).join("\n") ?? "";
		expect(system).toContain("気分: 0.30");
		expect(system).toContain("eve との関係");
		expect(system).toContain("親しさ: 0.42");
		expect(system).toContain("信頼: 0.52");
	});

	it("同じ作者は同じ entity に解決され、別の作者は別になる", async () => {
		const { stub } = await setup("state-entity", [
			response(),
			response(),
			response(),
		]);
		const a = { id: "u-ent-a", displayName: "a", isBot: false };
		const b = { id: "u-ent-b", displayName: "b", isBot: false };
		await stub.handleDiscordMessage(mention({ author: a }));
		await stub.handleDiscordMessage(mention({ author: a, channelId: "c2" }));
		await stub.handleDiscordMessage(mention({ author: b }));
		const rels = await doRelationships(stub);
		expect(new Set(rels.map((r) => r.entity_id)).size).toBe(2);
		const identities = await env.DB.prepare(
			"SELECT external_id FROM external_identities WHERE external_id IN ('u-ent-a','u-ent-b')",
		).all();
		expect(identities.results).toHaveLength(2);
	});

	it("LLM を呼ばない経路では entity も作らない", async () => {
		const { stub } = await setup("state-noentity", []);
		await stub.handleDiscordMessage(
			inbound({
				author: { id: "u-quiet", displayName: "quiet", isBot: false },
			}),
		);
		const row = await env.DB.prepare(
			"SELECT count(*) AS n FROM external_identities WHERE external_id = 'u-quiet'",
		).first<{ n: number }>();
		expect(row?.n).toBe(0);
	});
});
