import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { HAIKU, SONNET } from "@yunomi/llm";
import { describe, expect, it } from "vitest";
import { inbound, PARTNER_ID, partnerStub } from "../helpers.ts";
import {
	auditFor,
	installFakeLlm,
	llmOk,
	mention,
	newScenario,
	permanentFailure,
	send,
	transientFailure,
	turn,
} from "./harness.ts";

const systemPrompt = (fake: { requests: { system: { text: string }[] }[] }) =>
	fake.requests
		.at(-1)
		?.system.map((b) => b.text)
		.join("\n") ?? "";

const relationshipOf = (entityId: string) =>
	runInDurableObject(partnerStub(PARTNER_ID), (_o, s) =>
		s.storage.sql
			.exec<{ familiarity: number; trust: number }>(
				"SELECT familiarity, trust FROM relationships WHERE entity_id = ?",
				entityId,
			)
			.one(),
	);

const entityIdOf = async (authorId: string) =>
	(
		await env.DB.prepare(
			"SELECT entity_id FROM external_identities WHERE provider = 'discord' AND external_id = ?",
		)
			.bind(authorId)
			.first<{ entity_id: string }>()
	)?.entity_id ?? "";

describe("reply と ignore", () => {
	it("メンションされたら返信し、トリガー発言への reply として返す", async () => {
		const s = newScenario();
		const fake = await installFakeLlm([
			llmOk(turn({ utterance: "おはようございます" })),
		]);
		const msg = mention(s);

		const res = await send(msg);

		expect(res).toEqual({
			action: "reply",
			content: "おはようございます",
			reply_to_message_id: msg.messageId,
		});
		expect(fake.requests).toHaveLength(1);
	});

	it("LLM が ignore を選んだら返信しない", async () => {
		const s = newScenario();
		const fake = await installFakeLlm([
			llmOk(turn({ utterance: "", reply_policy: "ignore" })),
		]);
		const msg = mention(s);

		expect(await send(msg)).toEqual({ action: "ignore" });

		expect(fake.requests).toHaveLength(1);
		const [row] = await auditFor(msg.eventId);
		expect(row).toMatchObject({ decision: "ignore", reason: "llm" });
	});

	it("呼ばれていない発言は LLM を呼ばずに無視する", async () => {
		const s = newScenario();
		const fake = await installFakeLlm([]);
		const msg = inbound({
			channelId: s.channelId,
			author: s.author,
			content: "今日は寒いね",
		});

		expect(await send(msg)).toEqual({ action: "ignore" });

		expect(fake.requests).toHaveLength(0);
		const [row] = await auditFor(msg.eventId);
		expect(row).toMatchObject({ decision: "ignore", reason: "not_addressed" });
	});
});

describe("再起動をまたぐ永続化", () => {
	it("記憶した事実は Durable Object を作り直しても次の応答に使われる", async () => {
		const s = newScenario();
		await installFakeLlm([
			llmOk(
				turn({
					memory_candidates: [
						{
							subject: "user",
							predicate: "好きな飲み物",
							object: { type: "string", value: "玄米茶" },
							confidence: 0.9,
							importance: 0.8,
							source: "user_statement",
						},
					],
				}),
			),
		]);
		await send(mention(s, { content: "玄米茶が好きなんだ" }));

		await evictDurableObject(partnerStub(PARTNER_ID));
		const next = await installFakeLlm([llmOk(turn())]);
		await send(mention(s, { content: "おすすめの飲み物は？" }));

		expect(systemPrompt(next)).toContain("玄米茶");
	});

	it("気分は Durable Object を作り直しても保たれる", async () => {
		const s = newScenario();
		await installFakeLlm([
			llmOk(turn({ emotion_delta: { mood: 0.1, energy: 0 } })),
		]);
		await send(mention(s));
		const moodOf = () =>
			runInDurableObject(partnerStub(PARTNER_ID), (_o, st) =>
				st.storage.sql
					.exec<{ mood: number }>("SELECT mood FROM partner_state")
					.one(),
			);
		const before = (await moodOf()).mood;

		await evictDurableObject(partnerStub(PARTNER_ID));

		expect((await moodOf()).mood).toBeCloseTo(before);
		const next = await installFakeLlm([llmOk(turn())]);
		await send(mention(s));
		expect(systemPrompt(next)).toContain(`気分: ${before.toFixed(2)}`);
	});
});

describe("relationship", () => {
	it("1 ターンの変化量は上限で切り詰められる", async () => {
		const s = newScenario();
		await installFakeLlm([
			llmOk(turn({ relationship_delta: { familiarity: 0.5, trust: 0.5 } })),
		]);
		const msg = mention(s);
		await send(msg);

		const [row] = await auditFor(msg.eventId);
		const detail = JSON.parse(row?.detail_json ?? "{}");
		expect(detail.relationship.applied).toEqual({
			familiarity: 0.02,
			trust: 0.02,
		});
	});

	it("同じ日に積み上げられる変化量には上限がある", async () => {
		const s = newScenario();
		const bump = () =>
			llmOk(turn({ relationship_delta: { familiarity: 0.02, trust: 0 } }));
		await installFakeLlm(Array.from({ length: 8 }, bump));
		await send(mention(s));
		const entityId = await entityIdOf(s.author.id);
		const afterOne = (await relationshipOf(entityId)).familiarity;

		for (let i = 0; i < 7; i++) await send(mention(s));

		const afterEight = (await relationshipOf(entityId)).familiarity;
		expect(afterEight - afterOne).toBeLessThanOrEqual(0.06 + 1e-9);
		expect(afterEight - afterOne + 0.02).toBeCloseTo(0.08);
	});
});

describe("失敗時の振る舞い", () => {
	it("Sonnet が一時的に失敗したら Haiku に切り替えて返信し、audit に残す", async () => {
		const s = newScenario();
		const fake = await installFakeLlm(
			[transientFailure(), llmOk(turn({ utterance: "お待たせ" }), HAIKU)],
			{ production: true },
		);
		const msg = mention(s);

		const res = await send(msg);

		expect(res).toMatchObject({ action: "reply", content: "お待たせ" });
		expect(fake.requests.map((r) => r.model)).toEqual([SONNET, HAIKU]);
		const [row] = await auditFor(msg.eventId);
		expect(row).toMatchObject({ fallback_used: 1, model: HAIKU, degraded: 0 });
	});

	it("LLM が使えないときは劣化 ignore にして audit に原因を残す", async () => {
		const s = newScenario();
		await installFakeLlm([permanentFailure()]);
		const msg = mention(s);

		expect(await send(msg)).toEqual({ action: "ignore" });

		const [row] = await auditFor(msg.eventId);
		expect(row).toMatchObject({
			decision: "ignore",
			reason: "error",
			degraded: 1,
			error_type: "ValidationFailed",
		});
	});
});

describe("audit", () => {
	it("どの種類のメッセージでも 1 件ずつ残り、思考過程のフィールドを持たない", async () => {
		const s = newScenario();
		await installFakeLlm([
			llmOk(turn()),
			llmOk(turn({ utterance: "", reply_policy: "ignore" })),
			permanentFailure(),
		]);
		const msgs = [
			mention(s),
			mention(s),
			mention(s),
			inbound({ channelId: `${s.channelId}-other`, author: s.author }),
		];
		for (const m of msgs) await send(m);

		for (const m of msgs) expect(await auditFor(m.eventId)).toHaveLength(1);

		const columns = await env.DB.prepare(
			"SELECT name FROM pragma_table_info('audit_events')",
		).all<{ name: string }>();
		for (const { name } of columns.results) {
			expect(name).not.toMatch(/reasoning|thinking|thought/i);
		}
		for (const m of msgs) {
			const [row] = await auditFor(m.eventId);
			expect(row?.detail_json).not.toMatch(/reasoning|thinking|thought/i);
		}
	});
});
