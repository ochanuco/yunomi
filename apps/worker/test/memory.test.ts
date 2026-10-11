import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TurnResponse } from "@yunomi/conversation";
import { FakeLLMProvider, HAIKU, ModelRouter } from "@yunomi/llm";
import { describe, expect, it } from "vitest";
import { inbound, partnerStub } from "./helpers.ts";

const BOT = env.PARTNER_DISCORD_USER_ID;

type Candidate = TurnResponse["memory_candidates"][number];

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
	subject: "user",
	predicate: "好きな飲み物",
	object: { type: "string", value: "緑茶" },
	confidence: 0.9,
	importance: 0.7,
	source: "user_statement",
	...over,
});

const response = (memory: Candidate[]): TurnResponse => ({
	utterance: "覚えました",
	reply_policy: "reply",
	decision_summary: "自己申告を受けた",
	emotion_delta: { mood: 0, energy: 0 },
	relationship_delta: { familiarity: 0, trust: 0 },
	interest_signals: [],
	opinion_signals: [],
	memory_candidates: memory,
	open_loops: [],
	resolved_open_loop_ids: [],
	tool_intents: [],
	needs_review: false,
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

const setup = async (name: string, script: Candidate[][]) => {
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider(script.map((m) => ok(response(m))));
	const clock = { now: new Date("2026-10-11T03:00:00Z") };
	await runInDurableObject(stub, (o) => {
		o.now = () => clock.now;
		o.createRouter = () => new ModelRouter({ provider: fake });
	});
	return { stub, fake, clock };
};

// D1 はテスト間で巻き戻らないため、テストごとに別の作者を使う。
let authorSeq = 0;
const newAuthor = (displayName = "alice") => {
	authorSeq += 1;
	return { id: `m-author-${authorSeq}`, displayName, isBot: false };
};
const say = (author: ReturnType<typeof newAuthor>, over = {}) =>
	inbound({
		author,
		mentionedUserIds: [BOT],
		content: "私は緑茶が好き",
		...over,
	});

const memoryOf = (req: { system: { text: string }[] } | undefined) =>
	req?.system.find((b) => b.text.startsWith("## 関連する記憶"))?.text ?? "";

type FactRow = {
	id: string;
	predicate: string;
	object_value: string;
	observed_at: string;
};

const factsOf = async (entityId: string) =>
	(
		await env.DB.prepare(
			"SELECT id, predicate, object_value, observed_at FROM facts WHERE subject_entity_id = ? ORDER BY importance DESC",
		)
			.bind(entityId)
			.all<FactRow>()
	).results;

const entityOf = async (author: ReturnType<typeof newAuthor>) =>
	(
		await env.DB.prepare(
			"SELECT entity_id FROM external_identities WHERE provider = 'discord' AND external_id = ?",
		)
			.bind(author.id)
			.first<{ entity_id: string }>()
	)?.entity_id as string;

const candidatesOf = async (entityId: string | null, predicate: string) =>
	(
		await env.DB.prepare(
			"SELECT status, conflict_fact_id, subject_entity_id, subject_text FROM memory_candidates WHERE predicate = ? AND (subject_entity_id IS ? OR subject_entity_id = ?)",
		)
			.bind(predicate, entityId, entityId)
			.all<{
				status: string;
				conflict_fact_id: string | null;
				subject_entity_id: string | null;
				subject_text: string | null;
			}>()
	).results;

describe("Fact memory", () => {
	it("自己申告 -> Fact 化 -> 次のプロンプトに含まれる", async () => {
		const a = newAuthor();
		const { stub, fake } = await setup("mem-flow", [[candidate()], []]);
		const first = await stub.handleDiscordMessage(say(a));
		expect(first.audit.memory?.outcomes).toMatchObject([
			{ predicate: "好きな飲み物", status: "promoted" },
		]);

		const entity = await entityOf(a);
		const rows = await factsOf(entity);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			predicate: "好きな飲み物",
			object_value: "緑茶",
		});
		expect(memoryOf(fake.requests[0])).toContain("（なし）");

		await stub.handleDiscordMessage(say(a, { content: "今日は何を飲もう" }));
		expect(memoryOf(fake.requests[1])).toContain("alice 好きな飲み物 緑茶");
	});

	it("同じ値の再申告は observed_at を更新するだけ", async () => {
		const a = newAuthor();
		const { stub, clock } = await setup("mem-refresh", [
			[candidate()],
			[candidate()],
		]);
		await stub.handleDiscordMessage(say(a));
		clock.now = new Date("2026-10-12T03:00:00Z");
		await stub.handleDiscordMessage(say(a));
		const rows = await factsOf(await entityOf(a));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.observed_at).toBe("2026-10-12T03:00:00.000Z");
	});

	it("値が違えば conflict として残し、Fact は置換しない", async () => {
		const a = newAuthor();
		const { stub, fake } = await setup("mem-conflict", [
			[candidate()],
			[candidate({ object: { type: "string", value: "紅茶" } })],
			[],
		]);
		await stub.handleDiscordMessage(say(a));
		const res = await stub.handleDiscordMessage(
			say(a, { content: "紅茶が好き" }),
		);
		const entity = await entityOf(a);
		const rows = await factsOf(entity);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.object_value).toBe("緑茶");
		expect(res.audit.memory?.outcomes[0]).toMatchObject({
			status: "conflict",
			conflictFactId: rows[0]?.id,
		});
		const cands = await candidatesOf(entity, "好きな飲み物");
		expect(cands.map((c) => c.status).sort()).toEqual(["conflict", "promoted"]);
		expect(cands.find((c) => c.status === "conflict")?.conflict_fact_id).toBe(
			rows[0]?.id,
		);
		await stub.handleDiscordMessage(say(a, { content: "続き" }));
		expect(memoryOf(fake.requests[2])).toContain("緑茶");
		expect(memoryOf(fake.requests[2])).not.toContain("紅茶");
	});

	it("predicate を正規化して同じ Fact として扱う", async () => {
		const a = newAuthor();
		const { stub } = await setup("mem-normalize", [
			[
				candidate({
					predicate: "Favorite  Color",
					object: { type: "string", value: "青" },
				}),
			],
			[
				candidate({
					predicate: " favorite color ",
					object: { type: "string", value: "青" },
				}),
			],
		]);
		await stub.handleDiscordMessage(say(a));
		await stub.handleDiscordMessage(say(a));
		const rows = await factsOf(await entityOf(a));
		expect(rows.filter((r) => r.predicate === "favorite color")).toHaveLength(
			1,
		);
	});

	it("inferred・低 confidence・話者以外が主語・型不正は Fact にならない", async () => {
		const a = newAuthor();
		const { stub } = await setup("mem-pending", [
			[
				candidate({ predicate: "p-inferred", source: "inferred" }),
				candidate({ predicate: "p-low", confidence: 0.5 }),
				candidate({ predicate: "p-other", subject: "bob" }),
				candidate({
					predicate: "p-bad",
					object: { type: "number", value: "abc" },
				}),
			],
		]);
		const res = await stub.handleDiscordMessage(say(a));
		expect(res.audit.memory?.outcomes.map((o) => o.status)).toEqual([
			"pending",
			"pending",
			"pending",
			"rejected",
		]);
		const entity = await entityOf(a);
		expect(await factsOf(entity)).toHaveLength(0);
		const other = await candidatesOf(null, "p-other");
		expect(other[0]).toMatchObject({
			status: "pending",
			subject_entity_id: null,
			subject_text: "bob",
		});
		const bad = await candidatesOf(entity, "p-bad");
		expect(bad[0]?.status).toBe("rejected");
	});

	it("他の人の Fact は話者のプロンプトに出ない", async () => {
		const a = newAuthor();
		const { stub, fake } = await setup("mem-isolation", [[candidate()], []]);
		await stub.handleDiscordMessage(say(a));
		await stub.handleDiscordMessage(say(newAuthor("bob")));
		expect(memoryOf(fake.requests[1])).toContain("（なし）");
	});

	it("プロンプトには importance 順の上位 12 件だけを入れる", async () => {
		const a = newAuthor();
		const many = Array.from({ length: 14 }, (_, i) =>
			candidate({
				predicate: `item-${String(i).padStart(2, "0")}`,
				object: { type: "string", value: `v${i}` },
				importance: (i + 1) / 20,
			}),
		);
		const { stub, fake } = await setup("mem-top", [many, []]);
		await stub.handleDiscordMessage(say(a));
		await stub.handleDiscordMessage(say(a, { content: "次" }));
		const block = memoryOf(fake.requests[1]);
		expect(block.match(/alice item-/g)).toHaveLength(12);
		expect(block).toContain("item-13");
		expect(block).not.toContain("item-00");
		expect(block).not.toContain("item-01 ");
	});
});
