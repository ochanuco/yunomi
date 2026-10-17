import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
	RelationshipsResponseSchema,
	STATE_HISTORY_MAX_DAYS,
	StateHistoryResponseSchema,
} from "@yunomi/admin-contract";
import { FakeLLMProvider, HAIKU, ModelRouter } from "@yunomi/llm";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { turn } from "./e2e/harness.ts";
import { inbound, PARTNER_ID, partnerStub } from "./helpers.ts";

const BASE = `/admin/api/partners/${PARTNER_ID}`;
const get = (path: string) =>
	exports.default.fetch(
		new Request(`http://localhost${path}`, {
			headers: { "x-yunomi-dev-caller": "ykm" },
		}),
	);
const history = async (query = "") => {
	const res = await get(`${BASE}/state-history${query}`);
	expect(res.status).toBe(200);
	return v.parse(StateHistoryResponseSchema, await res.json());
};

const runTurn = async () => {
	const fake = new FakeLLMProvider([
		{
			ok: true,
			value: {
				output: turn({
					emotion_delta: { mood: 0.1, energy: 0 },
					relationship_delta: { familiarity: 0.02, trust: 0 },
				}),
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
		},
	]);
	const stub = partnerStub(PARTNER_ID);
	await runInDurableObject(stub, (o) => {
		o.createRouter = () => new ModelRouter({ provider: fake });
	});
	await stub.handleDiscordMessage(
		inbound({
			mentionedUserIds: [env.PARTNER_DISCORD_USER_ID],
			author: { id: "hist-u1", displayName: "alice", isBot: false },
		}),
	);
	await stub.flushBackground();
};

const insertRelEvent = (
	id: string,
	entityId: string,
	occurredAt: string,
	familiarityDelta: number,
) =>
	env.DB.prepare(
		`INSERT INTO relationship_events (id, partner_id, entity_id, type, summary, familiarity_delta, trust_delta, closeness_delta, tension_delta, source, confidence, related_episode_id, reason, occurred_at)
		VALUES (?1, ?2, ?3, 'turn_delta', 's', ?4, 0, NULL, NULL, 'llm_turn', 1, NULL, 'bounded_delta_applied', ?5)`,
	)
		.bind(id, PARTNER_ID, entityId, familiarityDelta, occurredAt)
		.run();

const daysAgo = (n: number) =>
	new Date(Date.now() - n * 86_400_000).toISOString();

describe("state-history", () => {
	it("days が不正なら 400", async () => {
		for (const q of [
			"0",
			"-1",
			"1.5",
			"abc",
			`${STATE_HISTORY_MAX_DAYS + 1}`,
		]) {
			const res = await get(`${BASE}/state-history?days=${q}`);
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "invalid_days" });
		}
		expect((await get(`${BASE}/state-history?days=90`)).status).toBe(200);
	});

	it("初回ターン前は空で state_at_start が null", async () => {
		const r = await history();
		expect(r).toMatchObject({
			state_at_start: null,
			transitions: [],
			relationships: [],
			truncated: false,
		});
		expect(Date.parse(r.since)).toBeLessThan(Date.now());
	});

	it("遷移を古い順で返し、関係の適用後の値を現在値から逆算する", async () => {
		await runTurn();
		const rels = v.parse(
			RelationshipsResponseSchema,
			await (await get(`${BASE}/relationships`)).json(),
		);
		const entityId = rels.items[0]?.entity_id ?? "";
		await insertRelEvent("old-in-range", entityId, daysAgo(2), 0.1);
		await insertRelEvent("old-out-of-range", entityId, daysAgo(10), 0.3);

		const r = await history("?days=7");
		expect(r.transitions).toHaveLength(1);
		const t = r.transitions[0];
		expect(t?.reason).toBe("turn_delta");
		expect(t?.after.mood).toBeCloseTo(0.3);
		expect(t?.before.mood).toBeCloseTo(0.2);
		expect(r.state_at_start).toEqual(t?.before);

		expect(r.relationships.map((e) => e.id)).toHaveLength(2);
		const [older, newer] = r.relationships;
		expect(older?.id).toBe("old-in-range");
		expect(newer?.display_name).toBe("alice");
		expect(newer?.familiarity).toBeCloseTo(0.42);
		expect(newer?.familiarity_delta).toBeCloseTo(0.02);
		expect(older?.familiarity).toBeCloseTo(0.4);
		expect(r.truncated).toBe(false);

		const short = await history("?days=1");
		expect(short.relationships).toHaveLength(1);
	});
});
