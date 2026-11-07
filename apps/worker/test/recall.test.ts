import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { err, newId, ok } from "@yunomi/core";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it } from "vitest";
import { PROMPT_FACT_LIMIT } from "../src/memory.ts";
import type { VectorDeps } from "../src/memory-index/index.ts";
import { parsePeriod } from "../src/memory-index/period.ts";
import {
	createRecaller,
	fuseHits,
	keywordTerms,
	RECALL_LIMIT,
	type RecallRequest,
	VECTOR_MIN_SCORE,
} from "../src/memory-index/recall.ts";
import {
	auditFor,
	gate,
	installFakeLlm,
	llmOk,
	mention,
	newScenario,
	send,
	turn,
} from "./e2e/harness.ts";
import { inbound, PARTNER_ID, partnerStub } from "./helpers.ts";

const db = drizzle(env.DB);

// JST 2026-11-07（土）12:00
const NOW = new Date("2026-11-07T03:00:00Z");
const jst = (date: string) => new Date(`${date}T00:00:00+09:00`);

describe("期間の表現", () => {
	const cases: [string, string, string][] = [
		["去年の春に京都へ行った", "2025-03-01", "2025-06-01"],
		["先月の話", "2026-10-01", "2026-11-01"],
		["去年の3月", "2025-03-01", "2025-04-01"],
		["3月にやったこと", "2026-03-01", "2026-04-01"],
		// 始まっていない 12 月は去年の 12 月
		["12月に行ったお店", "2025-12-01", "2026-01-01"],
		["今年の冬は寒かった", "2025-12-01", "2026-03-01"],
		["GWはどこにいた？", "2026-04-26", "2026-05-08"],
		["３日前", "2026-11-03", "2026-11-06"],
		["先週末", "2026-10-31", "2026-11-02"],
		["先週", "2026-10-26", "2026-11-02"],
		["一昨年の夏", "2024-06-01", "2024-09-01"],
		["去年", "2025-01-01", "2026-01-01"],
		// 体育の日の 3 連休（10/10〜10/12）。11/3 の祝日は 1 日だけなので連休ではない
		["この前の連休", "2026-10-10", "2026-10-13"],
	];
	it.each(cases)("%s", (text, from, to) => {
		expect(parsePeriod(text, NOW)).toEqual({ from: jst(from), to: jst(to) });
	});

	it("振替休日と国民の休日を含めて連休を数える", () => {
		// 2026 年 9 月は敬老の日（21 日）と秋分の日（23 日）に挟まれた 22 日が休みになる
		expect(
			parsePeriod("この前の連休", new Date("2026-09-28T03:00:00Z")),
		).toEqual({ from: jst("2026-09-19"), to: jst("2026-09-24") });
	});

	it("期間を表さない語は読まない", () => {
		expect(parsePeriod("春雨を食べた", NOW)).toBeNull();
		expect(parsePeriod("今日は暑い", NOW)).toBeNull();
		expect(parsePeriod("3ヶ月ぶりに会う", NOW)).toBeNull();
	});
});

describe("手がかりと並べ方", () => {
	it("漢字・カタカナ・英数字の 3 文字以上の連なりを語にする", () => {
		expect(
			keywordTerms(["去年の春に京都旅行した話、覚えてる？PCパーツも <@123>"]),
		).toEqual(["京都旅行", "パーツ"]);
	});

	it("意味検索は下限に届いたものだけを数え、両方に出たものを上にする", () => {
		const fused = fuseHits(
			[
				{ kind: "fact", sourceId: "a", score: 0.9 },
				{ kind: "fact", sourceId: "b", score: 0.8 },
				{ kind: "fact", sourceId: "low", score: VECTOR_MIN_SCORE - 0.01 },
			],
			[{ kind: "fact", sourceId: "b", at: NOW, score: -1 }],
		);
		expect(fused.map((c) => c.sourceId).sort()).toEqual(["a", "b"]);
		const [a, b] = ["a", "b"].map((id) => fused.find((c) => c.sourceId === id));
		expect(b?.fused).toBeGreaterThan(a?.fused ?? 0);
	});
});

let seq = 0;
const newEntity = async () => {
	seq += 1;
	const id = `rc-entity-${seq}-${newId()}`;
	await env.DB.prepare(
		"INSERT INTO entities (id, kind, display_name, created_at) VALUES (?, 'person', ?, ?)",
	)
		.bind(id, `person${seq}`, "2026-10-01T00:00:00.000Z")
		.run();
	return id;
};

const insertFact = async (
	entityId: string,
	predicate: string,
	value: string,
	over: { observedAt?: string; importance?: number } = {},
) => {
	const id = newId();
	const at = over.observedAt ?? "2026-10-01T00:00:00.000Z";
	await env.DB.prepare(
		`INSERT INTO facts (id, partner_id, subject_entity_id, predicate, object_type, object_value,
			confidence, importance, source, observed_at, valid_from)
		VALUES (?, ?, ?, ?, 'string', ?, 0.9, ?, 'user_statement', ?, ?)`,
	)
		.bind(
			id,
			PARTNER_ID,
			entityId,
			predicate,
			value,
			over.importance ?? 0.5,
			at,
			at,
		)
		.run();
	return id;
};

const insertChunk = async (body: string, occurredAt: string) => {
	const id = newId();
	await env.DB.prepare(
		`INSERT INTO conversation_chunks (id, partner_id, channel_id, body, started_at, occurred_at, ended_at)
		VALUES (?, ?, 'rc-channel', ?, ?, ?, ?)`,
	)
		.bind(id, PARTNER_ID, body, occurredAt, occurredAt, occurredAt)
		.run();
	return id;
};

const recallCountOf = async (factId: string) =>
	env.DB.prepare(
		"SELECT recall_count, last_recalled_at FROM facts WHERE id = ?",
	)
		.bind(factId)
		.first<{ recall_count: number; last_recalled_at: string | null }>();

describe("createRecaller", () => {
	const request = (
		entityId: string,
		cue: string[],
		over: Partial<RecallRequest> = {},
	): RecallRequest => ({
		partnerId: PARTNER_ID,
		entityId,
		includeConversation: false,
		cue,
		now: NOW,
		exclude: [],
		...over,
	});
	const keywordOnly = createRecaller(db, () => null);
	const ids = async (q: RecallRequest, recaller = keywordOnly) => {
		const r = await recaller.recall(q);
		if (!r.ok) throw new Error(r.error.type);
		return r.value.memories.map((m) => m.key.sourceId);
	};

	it("関係する発言には話し相手の記憶を浮かべ、関係しない発言には浮かべない", async () => {
		const me = await newEntity();
		const other = await newEntity();
		const mine = await insertFact(me, "趣味", "ボルダリングジム通い");
		await insertFact(other, "趣味", "ボルダリング大会");
		expect(await ids(request(me, ["週末はボルダリングに行こうかな"]))).toEqual([
			mine,
		]);
		expect(await ids(request(me, ["今日は雨ですね"]))).toEqual([]);
	});

	it("固定の枠にある記憶を除く", async () => {
		const me = await newEntity();
		const id = await insertFact(me, "好物", "シュークリーム専門店");
		expect(
			await ids(
				request(me, ["シュークリーム食べたい"], {
					exclude: [{ kind: "fact", sourceId: id }],
				}),
			),
		).toEqual([]);
	});

	it("期間の表現で絞る", async () => {
		const me = await newEntity();
		const spring = await insertFact(me, "旅行", "金沢旅行で兼六園", {
			observedAt: "2025-04-10T00:00:00.000Z",
		});
		await insertFact(me, "旅行の予定", "金沢旅行の計画", {
			observedAt: "2026-10-20T00:00:00.000Z",
		});
		const r = await keywordOnly.recall(
			request(me, ["去年の春の金沢旅行、楽しかったね"]),
		);
		expect(r.ok && r.value.memories.map((m) => m.key.sourceId)).toEqual([
			spring,
		]);
		expect(r.ok && r.value.period).toEqual({
			from: jst("2025-03-01"),
			to: jst("2025-06-01"),
		});
	});

	it("会話の塊は持ち主のターンだけ、直近ログと重ならないものを浮かべる", async () => {
		const me = await newEntity();
		const old = await insertChunk(
			"持ち主: 秋葉原でグラフィックボードを探した\nゆかり: 見つかりました？",
			"2026-09-01T00:00:00.000Z",
		);
		await insertChunk(
			"持ち主: グラフィックボードが届いた",
			"2026-11-07T02:59:00.000Z",
		);
		const cue = ["グラフィックボードの話"];
		expect(await ids(request(me, cue))).toEqual([]);
		const recalled = await keywordOnly.recall(
			request(me, cue, {
				includeConversation: true,
				conversationBefore: new Date("2026-11-07T02:00:00Z"),
			}),
		);
		expect(recalled.ok && recalled.value.memories).toEqual([
			{
				key: { kind: "conversation", sourceId: old },
				text: "持ち主: 秋葉原でグラフィックボードを探した\nゆかり: 見つかりました？",
				at: new Date("2026-09-01T00:00:00.000Z"),
			},
		]);
	});

	it(`最大 ${RECALL_LIMIT} 件`, async () => {
		const me = await newEntity();
		for (let i = 0; i < RECALL_LIMIT + 2; i++) {
			await insertFact(me, `ピクニック${i}`, `ピクニックの思い出${i}`);
		}
		expect(await ids(request(me, ["ピクニック行きたい"]))).toHaveLength(
			RECALL_LIMIT,
		);
	});

	it("意味検索は類似度の下限に届いたものだけを浮かべる", async () => {
		const me = await newEntity();
		const near = await insertFact(me, "ペット", "柴犬のこむぎ");
		const far = await insertFact(me, "職場", "駅前のビル");
		const vectors: VectorDeps = {
			embed: async (texts) => ok(texts.map(() => [1, 0, 0])),
			store: {
				upsert: async () => {},
				deleteByIds: async () => {},
				query: async () => ({
					matches: [
						{ id: `fact:${near}`, score: 0.82 },
						{ id: `fact:${far}`, score: 0.31 },
					],
				}),
			},
		};
		expect(
			await ids(
				request(me, ["犬を飼いたい"]),
				createRecaller(db, () => vectors),
			),
		).toEqual([near]);
	});

	it("埋め込みが失敗したら error を返す", async () => {
		const me = await newEntity();
		const failing: VectorDeps = {
			embed: async () => err({ type: "embedding_failed", message: "down" }),
			store: {
				upsert: async () => {},
				deleteByIds: async () => {},
				query: async () => ({ matches: [] }),
			},
		};
		const r = await createRecaller(db, () => failing).recall(
			request(me, ["なにか"]),
		);
		expect(r.ok).toBe(false);
	});

	it("markRecalled は回数と時刻を進め、索引からは外さない", async () => {
		const me = await newEntity();
		const id = await insertFact(me, "趣味", "スキューバダイビング");
		const key = { kind: "fact" as const, sourceId: id };
		expect((await keywordOnly.markRecalled([key], NOW)).ok).toBe(true);
		expect((await keywordOnly.markRecalled([key], NOW)).ok).toBe(true);
		expect(await recallCountOf(id)).toEqual({
			recall_count: 2,
			last_recalled_at: NOW.toISOString(),
		});
		expect(await ids(request(me, ["スキューバダイビング"]))).toEqual([id]);
	});
});

describe("返事のターンの連想", () => {
	afterEach(() =>
		runInDurableObject(partnerStub(PARTNER_ID), (o) => {
			o.memoryVectors = null;
		}),
	);

	const systemPrompt = (fake: { requests: { system: { text: string }[] }[] }) =>
		fake.requests
			.at(-1)
			?.system.map((b) => b.text)
			.join("\n") ?? "";

	const entityIdOf = async (authorId: string) =>
		(
			await env.DB.prepare(
				"SELECT entity_id FROM external_identities WHERE provider = 'discord' AND external_id = ?",
			)
				.bind(authorId)
				.first<{ entity_id: string }>()
		)?.entity_id as string;

	const countingVectors = (
		embed: VectorDeps["embed"] = async (texts) =>
			ok(texts.map(() => [1, 0, 0])),
	) => {
		const calls: string[][] = [];
		const deps: VectorDeps = {
			embed: async (texts) => {
				calls.push(texts);
				return embed(texts);
			},
			store: {
				upsert: async () => {},
				deleteByIds: async () => {},
				query: async () => ({ matches: [] }),
			},
		};
		return { deps, calls };
	};

	it("固定の枠の外の記憶を、関係する発言にだけ別の見出しで差し込み、想起を記録する", async () => {
		const s = newScenario();
		await installFakeLlm([llmOk(turn())]);
		await send(mention(s, { content: "はじめまして" }));
		const entityId = await entityIdOf(s.author.id);
		// 重要度の高い事実で固定の枠を埋め、低い事実を枠の外に置く
		for (let i = 0; i < PROMPT_FACT_LIMIT; i++) {
			await insertFact(entityId, `項目${i}`, `値${i}`, { importance: 0.9 });
		}
		const outside = await insertFact(entityId, "昔の趣味", "カヌー教室", {
			importance: 0.1,
			observedAt: "2025-05-03T00:00:00.000Z",
		});

		const fake = await installFakeLlm([
			llmOk(turn({ messages: ["カヌー、また行きます？"] })),
			llmOk(turn({ messages: ["今日は晴れですね"] })),
		]);
		const related = mention(s, { content: "カヌー教室のこと覚えてる？" });
		await send(related);
		const prompt = systemPrompt(fake);
		expect(prompt).toContain("## ふと思い出したこと");
		expect(prompt).toContain("自分から触れてよい");
		expect(prompt).toContain("- 昔の趣味 カヌー教室（2025/5/3）");
		expect(prompt.split("## ふと思い出したこと")[1]).not.toContain(
			"自分からは持ち出さない",
		);
		expect(
			JSON.parse((await auditFor(related.eventId))[0]?.detail_json ?? "")
				.recall,
		).toEqual({ keys: [`fact:${outside}`], error: null });
		expect((await recallCountOf(outside))?.recall_count).toBe(1);

		// 直近ログも手がかりになるので、関係しない発言は別のチャンネルで確かめる
		const elsewhere = { ...newScenario(), author: s.author };
		await send(mention(elsewhere, { content: "いい天気ですね" }));
		expect(systemPrompt(fake)).not.toContain("## ふと思い出したこと");
	});

	it("返事をしないターンでは埋め込みを呼ばない", async () => {
		const v = countingVectors();
		await runInDurableObject(partnerStub(PARTNER_ID), (o) => {
			o.memoryVectors = v.deps;
		});
		const s = newScenario();
		await installFakeLlm([gate(false)]);
		await send(
			inbound({
				channelId: s.channelId,
				author: s.author,
				content: "カヌーの話をしている",
			}),
		);
		expect(v.calls).toEqual([]);

		await installFakeLlm([llmOk(turn())]);
		await send(mention(s, { content: "カヌーに行きたい" }));
		expect(v.calls).toHaveLength(1);
		expect(v.calls[0]?.at(-1)).toContain("カヌーに行きたい");
	});

	it("埋め込みが失敗しても連想なしで返事をする", async () => {
		const v = countingVectors(async () =>
			err({ type: "embedding_failed", message: "down" }),
		);
		await runInDurableObject(partnerStub(PARTNER_ID), (o) => {
			o.memoryVectors = v.deps;
		});
		const s = newScenario();
		const fake = await installFakeLlm([llmOk(turn({ messages: ["はい"] }))]);
		const m = mention(s, { content: "カヌーの話" });
		const res = await send(m);
		expect(res.action).toBe("reply");
		expect(systemPrompt(fake)).not.toContain("## ふと思い出したこと");
		expect(
			JSON.parse((await auditFor(m.eventId))[0]?.detail_json ?? "").recall,
		).toEqual({
			keys: [],
			error: "embedding_failed",
		});
	});
});
