import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newId, ok } from "@yunomi/core";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it } from "vitest";
import { handleMemoryIndexRebuild } from "../src/admin/memory-index.ts";
import { createConversationLogWriter } from "../src/conversation-log.ts";
import { createMemoryRepo } from "../src/memory.ts";
import {
	buildChunks,
	CHUNK_CONTEXT_COUNT,
	type ChunkMessage,
} from "../src/memory-index/chunks.ts";
import {
	type IndexKey,
	removeConversationMessagesFromIndex,
	searchKeywords,
	searchVectors,
	syncVectors,
	type VectorDeps,
} from "../src/memory-index/index.ts";
import { toMatchExpression } from "../src/memory-index/keyword.ts";
import type { VectorStore } from "../src/memory-index/vectors.ts";
import { createWorkNoteRepo } from "../src/work-notes.ts";
import {
	installFakeLlm,
	llmOk,
	mention,
	newScenario,
	send,
	turn,
} from "./e2e/harness.ts";
import { PARTNER_ID, partnerStub } from "./helpers.ts";

const db = drizzle(env.DB);

// 埋め込みは本文の長さだけを見る。Vectorize は id ごとの最後の upsert を覚える。
const fakeVectors = () => {
	const vectors = new Map<string, VectorizeVector>();
	const queries: { vector: number[]; options: VectorizeQueryOptions }[] = [];
	const deleted: string[] = [];
	const store: VectorStore = {
		upsert: async (vs) => {
			for (const v of vs) vectors.set(v.id, v);
		},
		deleteByIds: async (ids) => {
			for (const id of ids) {
				vectors.delete(id);
				deleted.push(id);
			}
		},
		query: async (vector, options) => {
			queries.push({ vector, options });
			return {
				matches: [...vectors.keys()].map((id, i) => ({
					id,
					score: 1 - i / 10,
				})),
			};
		},
	};
	const deps: VectorDeps = {
		embed: async (texts) => ok(texts.map((t) => [t.length, 0, 0])),
		store,
	};
	return { deps, vectors, queries, deleted };
};

let seq = 0;
const newEntity = async () => {
	seq += 1;
	const id = `mi-entity-${seq}-${newId()}`;
	await env.DB.prepare(
		"INSERT INTO entities (id, kind, display_name, created_at) VALUES (?, 'person', ?, ?)",
	)
		.bind(id, `person${seq}`, "2026-10-01T00:00:00.000Z")
		.run();
	return id;
};

const insertFact = async (
	partnerId: string,
	entityId: string,
	predicate: string,
	value: string,
	observedAt = "2026-10-01T00:00:00.000Z",
) => {
	const id = newId();
	await env.DB.prepare(
		`INSERT INTO facts (id, partner_id, subject_entity_id, predicate, object_type, object_value,
			confidence, importance, source, observed_at, valid_from)
		VALUES (?, ?, ?, ?, 'string', ?, 0.9, 0.5, 'user_statement', ?, ?)`,
	)
		.bind(id, partnerId, entityId, predicate, value, observedAt, observedAt)
		.run();
	return id;
};

const keywordIds = async (
	partnerId: string,
	text: string,
	over: Partial<Parameters<typeof searchKeywords>[1]> = {},
) => {
	const r = await searchKeywords(db, { partnerId, text, topK: 10, ...over });
	if (!r.ok) throw new Error(r.error.type);
	return r.value.map((h) => `${h.kind}:${h.sourceId}`);
};

const msg = (
	id: string,
	over: Partial<ChunkMessage> & { minute: number },
): ChunkMessage => ({
	id,
	authorId: "owner",
	authorName: "持ち主",
	isPartner: false,
	content: id,
	...over,
	occurredAt: new Date(Date.UTC(2026, 9, 11, 3, over.minute)).toISOString(),
});

const partner = (id: string, minute: number) =>
	msg(id, { minute, authorId: "bot", authorName: "ゆかり", isPartner: true });

describe("buildChunks", () => {
	it("持ち主の発言に Partner の返事が続くところを塊にし、直前の発言を含める", () => {
		const chunks = buildChunks(
			[
				msg("o1", { minute: 0 }),
				partner("p1", 1),
				msg("o2", { minute: 2 }),
				partner("p2", 3),
				partner("p3", 3),
			],
			"owner",
		);
		expect(chunks.map((c) => [c.id, c.members.map((m) => m.id)])).toEqual([
			["o1", ["o1", "p1"]],
			["o2", ["o1", "p1", "o2", "p2", "p3"]],
		]);
		expect(chunks[1]?.body).toBe(
			"持ち主: o1\nゆかり: p1\n持ち主: o2\nゆかり: p2\nゆかり: p3",
		);
		expect(chunks[1]?.occurredAt).toBe("2026-10-11T03:02:00.000Z");
	});

	it("持ち主以外の発言は入れず、その人への返事は塊にしない", () => {
		const chunks = buildChunks(
			[
				msg("o1", { minute: 0 }),
				msg("x1", { minute: 1, authorId: "guest", authorName: "客" }),
				partner("p1", 2),
				msg("o2", { minute: 3 }),
				partner("p2", 4),
			],
			"owner",
		);
		expect(chunks.map((c) => [c.id, c.members.map((m) => m.id)])).toEqual([
			["o2", ["o1", "p1", "o2", "p2"]],
		]);
	});

	it("前の発言は 30 分以内で、最大件数まで", () => {
		const before = Array.from({ length: 6 }, (_, i) =>
			msg(`b${i}`, { minute: 20 + i }),
		);
		const chunks = buildChunks(
			[
				msg("old", { minute: 0 }),
				...before,
				msg("o", { minute: 45 }),
				partner("p", 46),
			],
			"owner",
		);
		const members = chunks[0]?.members.map((m) => m.id) ?? [];
		expect(members).toEqual(["b2", "b3", "b4", "b5", "o", "p"]);
		expect(members.length).toBe(CHUNK_CONTEXT_COUNT + 2);
	});
});

describe("toMatchExpression", () => {
	it("3 文字以上の語を引用して OR で繋ぐ", () => {
		expect(toMatchExpression('PC 探しに 行った "話"')).toBe(
			'"探しに" OR "行った" OR """話"""',
		);
		expect(toMatchExpression("猫 犬")).toBeNull();
	});
});

describe("FTS5 の索引", () => {
	it("facts の追加・置き換え・期限・削除に追従する", async () => {
		const p = `fts-facts-${newId()}`;
		const e = await newEntity();
		const a = await insertFact(p, e, "好きな飲み物", "ほうじ茶ラテ");
		const b = await insertFact(p, e, "行きたい場所", "秋葉原のパソコン屋");
		const c = await insertFact(p, e, "苦手な食べ物", "パクチー料理");
		expect(await keywordIds(p, "ほうじ茶")).toEqual([`fact:${a}`]);
		expect(await keywordIds(p, "パソコン")).toEqual([`fact:${b}`]);

		await env.DB.prepare("UPDATE facts SET superseded_by = ? WHERE id = ?")
			.bind(c, a)
			.run();
		expect(await keywordIds(p, "ほうじ茶")).toEqual([]);

		await env.DB.prepare("UPDATE facts SET valid_to = ? WHERE id = ?")
			.bind("2026-10-02T00:00:00.000Z", b)
			.run();
		expect(await keywordIds(p, "パソコン")).toEqual([]);

		expect(await keywordIds(p, "パクチー")).toEqual([`fact:${c}`]);
		await env.DB.prepare("DELETE FROM facts WHERE id = ?").bind(c).run();
		expect(await keywordIds(p, "パクチー")).toEqual([]);
	});

	it("partner・種類・期間で絞る", async () => {
		const p = `fts-filter-${newId()}`;
		const e = await newEntity();
		const early = await insertFact(
			p,
			e,
			"去年の旅行",
			"函館で温泉",
			"2025-04-01T00:00:00.000Z",
		);
		const late = await insertFact(
			p,
			e,
			"今年の旅行",
			"函館で朝市",
			"2026-09-01T00:00:00.000Z",
		);
		await insertFact(`${p}-other`, e, "旅行", "函館で夜景");
		const notes = createWorkNoteRepo(db);
		const note = await notes.add({
			partnerId: p,
			entityId: e,
			kind: "done",
			summary: "函館で使う旅程表を作った",
			now: new Date("2026-09-02T00:00:00Z"),
		});

		expect((await keywordIds(p, "函館で")).sort()).toEqual(
			[`fact:${early}`, `fact:${late}`, `work_note:${note.id}`].sort(),
		);
		expect(await keywordIds(p, "函館で", { kinds: ["work_note"] })).toEqual([
			`work_note:${note.id}`,
		]);
		expect(
			(
				await keywordIds(p, "函館で", {
					kinds: ["fact"],
					from: new Date("2026-01-01T00:00:00Z"),
					to: new Date("2027-01-01T00:00:00Z"),
				})
			).sort(),
		).toEqual([`fact:${late}`]);
	});
});

describe("書き込みの経路と Vectorize", () => {
	it("facts の追加で listener が呼ばれ、置き換えると Vectorize からも消える", async () => {
		const p = `vec-facts-${newId()}`;
		const e = await newEntity();
		const keys: IndexKey[] = [];
		const repo = createMemoryRepo(db, (k) => keys.push(...k));
		const [outcome] = await repo.processCandidates(
			{
				partnerId: p,
				speakerEntityId: e,
				speakerAliases: ["user"],
				sourceEventId: newId(),
				now: new Date("2026-10-11T03:00:00Z"),
			},
			[
				{
					subject: "user",
					predicate: "好きな飲み物",
					object: { type: "string", value: "緑茶" },
					confidence: 0.9,
					importance: 0.7,
					source: "user_statement",
					kind: "lasting",
				},
			],
		);
		const factId = outcome?.factId as string;
		expect(keys).toEqual([{ kind: "fact", sourceId: factId }]);

		const v = fakeVectors();
		expect(await syncVectors(db, v.deps, keys)).toEqual(
			ok({ upserted: 1, removed: 0 }),
		);
		expect(v.vectors.get(`fact:${factId}`)?.metadata).toEqual({
			partner_id: p,
			kind: "fact",
			source_id: factId,
			at: Date.parse("2026-10-11T03:00:00Z"),
		});

		await env.DB.prepare("UPDATE facts SET superseded_by = 'x' WHERE id = ?")
			.bind(factId)
			.run();
		expect(await syncVectors(db, v.deps, keys)).toEqual(
			ok({ upserted: 0, removed: 1 }),
		);
		expect(v.vectors.size).toBe(0);
	});

	it("work_notes の追加で listener が呼ばれる", async () => {
		const p = `vec-notes-${newId()}`;
		const e = await newEntity();
		const keys: IndexKey[] = [];
		const repo = createWorkNoteRepo(db, (k) => keys.push(...k));
		const note = await repo.add({
			partnerId: p,
			entityId: e,
			kind: "decided",
			summary: "週末に配線を直す",
			now: new Date("2026-10-11T03:00:00Z"),
		});
		const goal = await repo.openGoal({
			partnerId: p,
			entityId: e,
			summary: "毎朝走る",
			now: new Date("2026-10-11T03:00:00Z"),
		});
		expect(keys).toEqual([
			{ kind: "work_note", sourceId: note.id },
			{ kind: "work_note", sourceId: goal.ok ? goal.value.id : "" },
		]);
	});

	it("searchVectors は partner・種類・期間を filter に入れる", async () => {
		const v = fakeVectors();
		v.vectors.set("fact:a", { id: "fact:a", values: [] });
		v.vectors.set("conversation:b", { id: "conversation:b", values: [] });
		const r = await searchVectors(v.deps, {
			partnerId: "yukarin",
			text: "PC",
			topK: 5,
			kinds: ["fact", "conversation"],
			from: new Date("2025-03-01T00:00:00Z"),
			to: new Date("2025-06-01T00:00:00Z"),
		});
		expect(r).toEqual(
			ok([
				{ kind: "fact", sourceId: "a", score: 1 },
				{ kind: "conversation", sourceId: "b", score: 0.9 },
			]),
		);
		expect(v.queries[0]?.options).toEqual({
			topK: 5,
			filter: {
				partner_id: "yukarin",
				kind: { $in: ["fact", "conversation"] },
				at: {
					$gte: Date.parse("2025-03-01T00:00:00Z"),
					$lt: Date.parse("2025-06-01T00:00:00Z"),
				},
			},
		});
	});
});

describe("会話ログの索引", () => {
	afterEach(() =>
		runInDurableObject(partnerStub(PARTNER_ID), (o) => {
			o.ownerDiscordUserId = undefined;
			o.memoryVectors = null;
			o.now = () => new Date();
		}),
	);

	const chunkRows = async (channelId: string) =>
		(
			await env.DB.prepare(
				"SELECT id, body FROM conversation_chunks WHERE channel_id = ? ORDER BY occurred_at",
			)
				.bind(channelId)
				.all<{ id: string; body: string }>()
		).results;

	const rowIdOf = async (channelId: string, messageId: string) =>
		(
			await env.DB.prepare(
				"SELECT id FROM conversation_messages WHERE channel_id = ? AND message_id = ?",
			)
				.bind(channelId, messageId)
				.first<{ id: string }>()
		)?.id as string;

	it("持ち主との返事のターンを塊にして、FTS5 と Vectorize に入れる", async () => {
		const s = newScenario();
		const v = fakeVectors();
		await runInDurableObject(partnerStub(PARTNER_ID), (o) => {
			o.ownerDiscordUserId = s.author.id;
			o.memoryVectors = v.deps;
		});
		await installFakeLlm([llmOk(turn({ messages: ["秋葉原の話ですね"] }))]);
		const m = mention(s, { content: "前に秋葉原でPCパーツを見た" });
		await send(m);

		const anchor = await rowIdOf(s.channelId, m.messageId);
		const chunks = await chunkRows(s.channelId);
		expect(chunks).toEqual([
			{
				id: anchor,
				body: expect.stringMatching(
					new RegExp(
						`^${s.author.displayName}: 前に秋葉原でPCパーツを見た\n.+: 秋葉原の話ですね$`,
					),
				),
			},
		]);
		expect(await keywordIds(PARTNER_ID, "PCパーツ")).toContain(
			`conversation:${anchor}`,
		);
		expect(v.vectors.get(`conversation:${anchor}`)?.metadata).toMatchObject({
			partner_id: PARTNER_ID,
			kind: "conversation",
			source_id: anchor,
		});
	});

	it("持ち主でない人との会話は塊にしない", async () => {
		const s = newScenario();
		await runInDurableObject(partnerStub(PARTNER_ID), (o) => {
			o.ownerDiscordUserId = "someone-else";
		});
		await installFakeLlm([llmOk(turn({ messages: ["はい"] }))]);
		await send(mention(s, { content: "他人の話題です" }));
		expect(await chunkRows(s.channelId)).toEqual([]);
	});

	it("会話ログの行を消すと、塊を作り直すか消し、Vectorize からも消す", async () => {
		const s = newScenario();
		const v = fakeVectors();
		const clock = { now: new Date("2026-10-11T03:01:00Z") };
		await installFakeLlm([
			llmOk(turn({ messages: ["一つ目の返事"] })),
			llmOk(turn({ messages: ["二つ目の返事"] })),
		]);
		// 返事の時刻を受信より後にする。installFakeLlm が時計を固定するので、その後で差し替える。
		await runInDurableObject(partnerStub(PARTNER_ID), (o) => {
			o.ownerDiscordUserId = s.author.id;
			o.memoryVectors = v.deps;
			o.now = () => clock.now;
		});
		const first = mention(s, {
			content: "最初の話題",
			occurredAt: new Date("2026-10-11T03:00:00Z"),
		});
		await send(first);
		clock.now = new Date("2026-10-11T03:06:00Z");
		const second = mention(s, {
			content: "次の話題",
			occurredAt: new Date("2026-10-11T03:05:00Z"),
		});
		await send(second);
		const a1 = await rowIdOf(s.channelId, first.messageId);
		const a2 = await rowIdOf(s.channelId, second.messageId);
		expect((await chunkRows(s.channelId)).map((c) => c.id)).toEqual([a1, a2]);
		expect((await chunkRows(s.channelId))[1]?.body).toContain("最初の話題");

		const removed = await removeConversationMessagesFromIndex(db, v.deps, [a1]);
		expect(removed).toEqual(
			ok({
				keys: expect.arrayContaining([
					{ kind: "conversation", sourceId: a1 },
					{ kind: "conversation", sourceId: a2 },
				]),
				removedChunks: 1,
				rebuiltChunks: 1,
			}),
		);
		const rest = await chunkRows(s.channelId);
		expect(rest.map((c) => c.id)).toEqual([a2]);
		expect(rest[0]?.body).not.toContain("最初の話題");
		expect(v.deleted).toContain(`conversation:${a1}`);
		expect(v.vectors.has(`conversation:${a2}`)).toBe(true);
		expect(await keywordIds(PARTNER_ID, "最初の話題")).toEqual([]);
	});
});

describe("一括投入", () => {
	const rebuild = (body: unknown, over: Partial<Env> = {}) =>
		handleMemoryIndexRebuild(
			new Request("http://localhost/", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			{ ...env, ...over },
			PARTNER_ID,
		);

	it("持ち主が分からなければ会話ログを塊にしない", async () => {
		const res = await rebuild({ step: "chunks", cursor: null });
		expect(await res.json()).toEqual({
			step: "chunks",
			processed: 0,
			next_cursor: null,
			skipped: "owner_unknown",
		});
	});

	it("既存の会話ログからチャンネルごとに塊を作る", async () => {
		const owner = `rebuild-owner-${newId()}`;
		const channelId = `zz-rebuild-${newId()}`;
		const writer = createConversationLogWriter(db);
		const at = (minute: number) =>
			new Date(Date.UTC(2026, 9, 11, 3, minute)).toISOString();
		await writer.record(
			{ partnerId: PARTNER_ID, turnEventId: newId(), now: new Date() },
			[
				{
					channelId,
					messageId: "r1",
					authorId: owner,
					authorName: "持ち主",
					isBot: false,
					isPartner: false,
					content: "古い会話の話題",
					occurredAt: at(0),
				},
				{
					channelId,
					messageId: "r2",
					authorId: "bot",
					authorName: "ゆかり",
					isBot: true,
					isPartner: true,
					content: "古い返事",
					occurredAt: at(1),
				},
			],
		);
		let cursor: string | null = null;
		let processed = 0;
		do {
			const res = await rebuild(
				{ step: "chunks", cursor },
				{ OWNER_DISCORD_USER_ID: owner },
			);
			const body = await res.json<{
				processed: number;
				next_cursor: string | null;
			}>();
			processed += body.processed;
			cursor = body.next_cursor;
		} while (cursor !== null);
		expect(processed).toBeGreaterThanOrEqual(1);
		expect(await keywordIds(PARTNER_ID, "古い会話の話題")).toHaveLength(1);
	});

	it("Vectorize の binding が無ければ vectors は 503", async () => {
		const res = await rebuild({ step: "vectors", cursor: null });
		expect(res.status).toBe(503);
	});

	it("step が不正なら 400", async () => {
		const res = await rebuild({ step: "all", cursor: null });
		expect(res.status).toBe(400);
	});
});
