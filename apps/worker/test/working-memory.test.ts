import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { FakeLLMProvider, ModelRouter } from "@yunomi/llm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import {
	createMemoryRepo,
	PROMPT_EPISODE_LIMIT,
	PROMPT_FACT_LIMIT,
} from "../src/memory.ts";
import { WORK_NOTE_PROMPT_LIMIT } from "../src/work-notes.ts";
import { inbound, PARTNER_ID, partnerStub } from "./helpers.ts";
import { final } from "./llm-fixtures.ts";

const BOT = env.PARTNER_DISCORD_USER_ID;
const URL_MEMORY = `http://localhost/v1/partners/${PARTNER_ID}/working/memory`;
const working = { "x-yunomi-dev-caller": "working" };

// D1 はテスト間で巻き戻らないため、テストごとに別の作者を使う。
let authorSeq = 0;
const newAuthor = () => {
	authorSeq += 1;
	return { id: `w-author-${authorSeq}`, displayName: "alice", isBot: false };
};

const read = (discordUserId: string, headers = working) =>
	exports.default.fetch(
		new Request(`${URL_MEMORY}?discord_user_id=${discordUserId}`, { headers }),
	);

const write = (body: unknown, headers: Record<string, string> = working) =>
	exports.default.fetch(
		new Request(URL_MEMORY, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		}),
	);

type ReadBody = {
	facts: { predicate: string; object: string; observed_at: string }[];
	episodes: { predicate: string; object: string; observed_at: string }[];
	open_loops: { id: string; summary: string; due_at: string | null }[];
};

/** Talking で1回話して entity・関係性・直近の履歴を作る。 */
const talkOnce = async (name: string, author: ReturnType<typeof newAuthor>) => {
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider();
	fake.enqueueStep(final("はい"));
	fake.enqueueStep(final("覚えてますよ"));
	await runInDurableObject(stub, (o) => {
		o.now = () => new Date("2026-10-11T03:00:00Z");
		o.createRouter = () => new ModelRouter({ provider: fake });
	});
	await stub.handleDiscordMessage(
		inbound({ author, mentionedUserIds: [BOT], content: "こんにちは" }),
	);
	await stub.flushBackground();
	const entity = await env.DB.prepare(
		"SELECT entity_id FROM external_identities WHERE provider = 'discord' AND external_id = ?",
	)
		.bind(author.id)
		.first<{ entity_id: string }>();
	return { stub, fake, entityId: entity?.entity_id as string };
};

const countRows = async (table: string) =>
	(
		await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
			n: number;
		}>()
	)?.n;

// DO の SQLite の全テーブル（状態・関係性・直近の会話履歴など）を丸ごと読む。
const dumpDo = (stub: ReturnType<typeof partnerStub>) =>
	runInDurableObject(stub, (_o, state) => {
		const sql = state.storage.sql;
		const tables = sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
			)
			.toArray()
			.map((r) => r.name);
		return Object.fromEntries(
			tables.map((t) => [t, sql.exec(`SELECT * FROM ${t}`).toArray()]),
		);
	});

const D1_TALKING_ONLY = [
	"relationship_events",
	"interest_states",
	"opinion_states",
	"interest_changes",
	"opinion_changes",
	"state_transitions",
	"conversation_messages",
	"entities",
	"external_identities",
];

const dumpD1 = async () =>
	Object.fromEntries(
		await Promise.all(
			D1_TALKING_ONLY.map(async (t) => [
				t,
				(await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())
					.results,
			]),
		),
	);

describe("Working の記憶の口", () => {
	it("working の service だけが使える", async () => {
		const a = newAuthor();
		expect((await read(a.id, {} as typeof working)).status).toBe(401);
		for (const caller of ["gateway", "ykm"]) {
			const headers = { "x-yunomi-dev-caller": caller };
			expect((await read(a.id, headers)).status).toBe(403);
			expect(
				(
					await write(
						{ discord_user_id: a.id, kind: "done", summary: "x" },
						headers,
					)
				).status,
			).toBe(403);
		}
	});

	it("Talking で話したことのない相手は 404 で、entity を作らない", async () => {
		const a = newAuthor();
		const before = [
			await countRows("entities"),
			await countRows("external_identities"),
			await countRows("work_notes"),
		];
		expect((await read(a.id)).status).toBe(404);
		const res = await write({
			discord_user_id: a.id,
			kind: "decided",
			summary: "週次で見直す",
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "unknown_entity" });
		expect([
			await countRows("entities"),
			await countRows("external_identities"),
			await countRows("work_notes"),
		]).toEqual(before);
	});

	it("1行でない・種類の違う書き込みは 400", async () => {
		const a = newAuthor();
		await talkOnce("work-validate", a);
		for (const body of [
			{ discord_user_id: a.id, kind: "decided", summary: "1行目\n2行目" },
			{ discord_user_id: a.id, kind: "decided", summary: "   " },
			{ discord_user_id: a.id, kind: "decided", summary: "あ".repeat(201) },
			{ discord_user_id: a.id, kind: "chat", summary: "雑談した" },
		]) {
			expect((await write(body)).status).toBe(400);
		}
	});

	it("事実・できごと・未決を読み、書いた1行ができごとに出る", async () => {
		const a = newAuthor();
		const { entityId } = await talkOnce("work-read", a);
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO facts (id, partner_id, subject_entity_id, predicate, object_type, object_value, confidence, importance, source, observed_at, valid_from, decay_policy)
				 VALUES ('wf1', ?, ?, '好きな飲み物', 'string', '緑茶', 0.9, 0.7, 'user_statement', '2026-10-10T03:00:00.000Z', '2026-10-10T03:00:00.000Z', 'standard'),
				        ('wf2', ?, ?, '行った所', 'string', '京都', 0.9, 0.5, 'user_statement', '2026-10-09T03:00:00.000Z', '2026-10-09T03:00:00.000Z', 'episodic')`,
			).bind(PARTNER_ID, entityId, PARTNER_ID, entityId),
			env.DB.prepare(
				`INSERT INTO open_loops (id, partner_id, entity_id, channel_id, summary, importance, due_at, status, source_message_id, created_at, updated_at)
				 VALUES ('wl1', ?, ?, 'c1', '面接の結果待ち', 0.8, '2026-10-12T01:00:00.000Z', 'open', 'm1', '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z')`,
			).bind(PARTNER_ID, entityId),
		]);

		const res = await write({
			discord_user_id: a.id,
			kind: "decided",
			summary: "  リリースは金曜に出す  ",
		});
		expect(res.status).toBe(201);
		const written = (await res.json()) as { id: string; summary: string };
		expect(written.summary).toBe("リリースは金曜に出す");

		const got = await read(a.id);
		expect(got.status).toBe(200);
		const body = (await got.json()) as ReadBody;
		expect(body.facts).toEqual([
			{
				predicate: "好きな飲み物",
				object: "緑茶",
				observed_at: "2026-10-10 12:00 JST",
			},
		]);
		expect(body.episodes.map((e) => [e.predicate, e.object])).toEqual([
			["仕事で決めたこと", "リリースは金曜に出す"],
			["行った所", "京都"],
		]);
		expect(body.episodes[0]?.observed_at).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} JST$/,
		);
		expect(body.open_loops).toEqual([
			{ id: "wl1", summary: "面接の結果待ち", due_at: "2026-10-12 10:00 JST" },
		]);
	});

	it("書いた1行を Talking が次の会話の記憶に使う", async () => {
		const a = newAuthor();
		const { stub, fake } = await talkOnce("work-talk", a);
		await write({
			discord_user_id: a.id,
			kind: "done",
			summary: "請求書を送った",
		});
		const asked = fake.requests.length;
		await stub.handleDiscordMessage(
			inbound({ author: a, mentionedUserIds: [BOT], content: "仕事どう？" }),
		);
		const memory =
			fake.requests[asked]?.system.find((b) =>
				b.text.startsWith("## 覚えていること"),
			)?.text ?? "";
		expect(memory).toContain("alice 仕事で終えたこと 請求書を送った");
	});

	it("読み書きの前後で関係性・興味・意見・直近の履歴は変わらない", async () => {
		const a = newAuthor();
		const { stub } = await talkOnce("work-untouched", a);
		const doBefore = await dumpDo(stub);
		const d1Before = await dumpD1();
		expect(doBefore).toHaveProperty("relationships");

		await read(a.id);
		await write({
			discord_user_id: a.id,
			kind: "decided",
			summary: "A案で進める",
		});
		await write({
			discord_user_id: a.id,
			kind: "done",
			summary: "PR を出した",
		});
		await read(a.id);

		expect(await dumpDo(stub)).toEqual(doBefore);
		expect(await dumpD1()).toEqual(d1Before);
	});
});

describe("Talking の記憶に混ぜる件数と順", () => {
	it("続く事実のあとに、できごとと仕事の1行を新しい順に並べ、仕事の1行は 10 件まで", async () => {
		const a = newAuthor();
		const { entityId } = await talkOnce("work-order", a);
		const insertFact = (
			id: string,
			predicate: string,
			observedAt: string,
			policy: string,
		) =>
			env.DB.prepare(
				`INSERT INTO facts (id, partner_id, subject_entity_id, predicate, object_type, object_value, confidence, importance, source, observed_at, valid_from, decay_policy)
				 VALUES (?, ?, ?, ?, 'string', 'v', 0.9, 0.5, 'user_statement', ?, ?, ?)`,
			).bind(
				id,
				PARTNER_ID,
				entityId,
				predicate,
				observedAt,
				observedAt,
				policy,
			);
		const insertNote = (i: number) =>
			env.DB.prepare(
				`INSERT INTO work_notes (id, partner_id, entity_id, kind, summary, created_at)
				 VALUES (?, ?, ?, 'done', ?, ?)`,
			).bind(
				`wn${i}`,
				PARTNER_ID,
				entityId,
				`作業${i}`,
				`2026-10-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
			);
		await env.DB.batch([
			insertFact("o1", "呼び名", "2026-10-01T00:00:00.000Z", "standard"),
			insertFact("o2", "行った所", "2026-10-05T12:00:00.000Z", "episodic"),
			...Array.from({ length: 12 }, (_, i) => insertNote(i)),
		]);

		const facts = await createMemoryRepo(drizzle(env.DB)).topFacts(
			PARTNER_ID,
			entityId,
		);
		expect(WORK_NOTE_PROMPT_LIMIT).toBe(10);
		expect(PROMPT_FACT_LIMIT).toBe(30);
		expect(PROMPT_EPISODE_LIMIT).toBe(30);
		expect(facts.map((f) => [f.kind, f.predicate, f.object])).toEqual([
			["lasting", "呼び名", "v"],
			// 作業11〜作業2 の 10 件。作業0・作業1 は上限で落ちる。
			...[11, 10, 9, 8, 7, 6, 5].map((i) => [
				"episode",
				"仕事で終えたこと",
				`作業${i}`,
			]),
			["episode", "行った所", "v"],
			...[4, 3, 2].map((i) => ["episode", "仕事で終えたこと", `作業${i}`]),
		]);
	});
});
