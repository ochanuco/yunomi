import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TurnResponse } from "@yunomi/conversation";
import { OPEN_LOOP_MAX_OPEN_PER_ENTITY } from "@yunomi/core";
import { FakeLLMProvider, ModelRouter } from "@yunomi/llm";
import { describe, expect, it } from "vitest";
import { llmOk, transientFailure, turn } from "./e2e/harness.ts";
import { inbound, partnerStub } from "./helpers.ts";

const BOT = env.PARTNER_DISCORD_USER_ID;

type Loop = TurnResponse["open_loops"][number];

const loop = (over: Partial<Loop> = {}): Loop => ({
	summary: "明日の面接の結果",
	importance: 0.7,
	due_at: "2026-10-12T03:00:00Z",
	due_confidence: 0.6,
	...over,
});

type Script = ReturnType<typeof llmOk> | ReturnType<typeof transientFailure>;

const setup = async (name: string, script: Script[]) => {
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider(script);
	const clock = { now: new Date("2026-10-11T03:00:00Z") };
	await runInDurableObject(stub, (o) => {
		o.now = () => clock.now;
		o.createRouter = () => new ModelRouter({ provider: fake });
	});
	return { stub, fake };
};

// D1 はテスト間で巻き戻らないため、テストごとに別の作者を使う。
let authorSeq = 0;
const newAuthor = (displayName = "alice") => {
	authorSeq += 1;
	return { id: `ol-author-${authorSeq}`, displayName, isBot: false };
};
const say = (
	author: ReturnType<typeof newAuthor>,
	content = "明日面接なんだ",
) => inbound({ author, mentionedUserIds: [BOT], content });

const entityOf = async (author: ReturnType<typeof newAuthor>) =>
	(
		await env.DB.prepare(
			"SELECT entity_id FROM external_identities WHERE provider = 'discord' AND external_id = ?",
		)
			.bind(author.id)
			.first<{ entity_id: string }>()
	)?.entity_id as string;

type Row = {
	id: string;
	entity_id: string;
	channel_id: string;
	summary: string;
	importance: number;
	due_at: string | null;
	due_confidence: number | null;
	follow_up_interval_hours: number | null;
	status: string;
	source_message_id: string;
	resolved_at: string | null;
	last_followed_up_at: string | null;
};

const rowsOf = async (entityId: string) =>
	(
		await env.DB.prepare(
			"SELECT * FROM open_loops WHERE entity_id = ? ORDER BY created_at, id",
		)
			.bind(entityId)
			.all<Row>()
	).results;

const loopsBlock = (req: { system: { text: string }[] } | undefined) =>
	req?.system.find((b) => b.text.startsWith("## 未解決の話題"))?.text ?? "";

const seedLoop = async (
	entityId: string,
	id: string,
	over: { summary?: string; importance?: number; status?: string } = {},
) => {
	await env.DB.prepare(
		`INSERT INTO open_loops (id, partner_id, entity_id, channel_id, summary, importance, status, source_message_id, created_at, updated_at)
		VALUES (?, 'yukarin', ?, 'c1', ?, ?, ?, 'seed', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
	)
		.bind(
			id,
			entityId,
			over.summary ?? id,
			over.importance ?? 0.5,
			over.status ?? "open",
		)
		.run();
};

describe("Open Loop の抽出と保存", () => {
	it("reply ターンの open_loops を保存し、audit と次の prompt に出す", async () => {
		const a = newAuthor();
		const { stub, fake } = await setup("ol-flow", [
			llmOk(turn({ open_loops: [loop()] })),
			llmOk(turn()),
		]);
		const first = await stub.handleDiscordMessage(say(a));
		await stub.flushBackground();

		const rows = await rowsOf(await entityOf(a));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			channel_id: "c1",
			summary: "明日の面接の結果",
			importance: 0.7,
			due_at: "2026-10-12T03:00:00.000Z",
			due_confidence: 0.6,
			follow_up_interval_hours: null,
			status: "open",
			source_message_id: first.audit.inbound.messageId,
			resolved_at: null,
			last_followed_up_at: null,
		});
		expect(first.audit.openLoops).toEqual({
			added: [rows[0]?.id],
			resolved: [],
			rejected: [],
			error: null,
		});

		expect(loopsBlock(fake.requests[0])).toContain("（なし）");
		await stub.handleDiscordMessage(say(a, "ただいま"));
		const block = loopsBlock(fake.requests[1]);
		expect(block).toContain(`[${rows[0]?.id}] 明日の面接の結果`);
		expect(block).toContain("期限の目安: 2026-10-12 12:00 JST");
	});

	it("audit の detail_json に追加・解決した id が残る", async () => {
		const a = newAuthor();
		const { stub } = await setup("ol-audit", [
			llmOk(turn({ open_loops: [loop()] })),
		]);
		const msg = say(a);
		const res = await stub.handleDiscordMessage(msg);
		await stub.flushBackground();
		const row = await env.DB.prepare(
			"SELECT detail_json FROM audit_events WHERE event_id = ?",
		)
			.bind(msg.eventId)
			.first<{ detail_json: string }>();
		const detail = JSON.parse(row?.detail_json ?? "{}");
		expect(detail.openLoops.added).toEqual(res.audit.openLoops?.added);
		expect(detail.openLoops.added).toHaveLength(1);
	});

	it("正規化後に同じ summary は追加しない", async () => {
		const a = newAuthor();
		const { stub } = await setup("ol-dedupe", [
			llmOk(turn({ open_loops: [loop({ summary: "面接 ABC" })] })),
			llmOk(turn({ open_loops: [loop({ summary: "　面接　ａｂｃ " })] })),
			llmOk(turn({ open_loops: [loop({ summary: "面接 abc" })] })),
		]);
		await stub.handleDiscordMessage(say(a));
		const second = await stub.handleDiscordMessage(say(a));
		expect(second.audit.openLoops).toMatchObject({
			added: [],
			rejected: ["duplicate"],
		});
		const rows = await rowsOf(await entityOf(a));
		expect(rows).toHaveLength(1);

		// 解決済みの summary は open ではないので、同じ話題をもう一度追加できる。
		await env.DB.prepare(
			"UPDATE open_loops SET status = 'resolved' WHERE entity_id = ?",
		)
			.bind(rows[0]?.entity_id)
			.run();
		await stub.handleDiscordMessage(say(a));
		expect(await rowsOf(await entityOf(a))).toHaveLength(2);
	});

	it("同じ summary でも別の話し相手なら追加する", async () => {
		const a = newAuthor("alice");
		const b = newAuthor("bob");
		const { stub } = await setup("ol-dedupe-entity", [
			llmOk(turn({ open_loops: [loop()] })),
			llmOk(turn({ open_loops: [loop()] })),
		]);
		await stub.handleDiscordMessage(say(a));
		await stub.handleDiscordMessage(say(b));
		expect(await rowsOf(await entityOf(a))).toHaveLength(1);
		expect(await rowsOf(await entityOf(b))).toHaveLength(1);
	});

	it("1 ターンは 2 件まで、entity あたりの open は 20 件まで", async () => {
		const a = newAuthor();
		const { stub } = await setup("ol-limit", [
			llmOk(
				turn({
					open_loops: ["a", "b", "c"].map((summary) => loop({ summary })),
				}),
			),
			llmOk(turn({ open_loops: [loop({ summary: "新しい話題" })] })),
		]);
		const first = await stub.handleDiscordMessage(say(a));
		expect(first.audit.openLoops?.added).toHaveLength(2);
		expect(first.audit.openLoops?.rejected).toEqual(["limit"]);

		const entity = await entityOf(a);
		for (let i = 0; i < OPEN_LOOP_MAX_OPEN_PER_ENTITY - 2; i++) {
			await seedLoop(entity, `${entity}-seed${i}`);
		}
		const second = await stub.handleDiscordMessage(say(a));
		expect(second.audit.openLoops).toMatchObject({
			added: [],
			rejected: ["limit"],
		});
		expect(await rowsOf(entity)).toHaveLength(OPEN_LOOP_MAX_OPEN_PER_ENTITY);
	});

	it("範囲外の数値や読めない日時の候補は clamp せず捨てる", async () => {
		const a = newAuthor();
		const { stub } = await setup("ol-invalid", [
			llmOk(
				turn({
					open_loops: [
						loop({ summary: "x", importance: 1.5 }),
						loop({ summary: "y", due_at: "いつか" }),
					],
				}),
			),
		]);
		const res = await stub.handleDiscordMessage(say(a));
		expect(res.audit.openLoops).toMatchObject({
			added: [],
			rejected: ["invalid", "invalid"],
		});
		expect(await rowsOf(await entityOf(a))).toHaveLength(0);
	});

	it("ignore のターンでは保存も解決もしない", async () => {
		const a = newAuthor();
		const { stub } = await setup("ol-ignore", [
			llmOk(turn({ open_loops: [loop()] })),
			llmOk(
				turn({
					reply_policy: "ignore",
					messages: [],
					open_loops: [loop({ summary: "別の話題" })],
				}),
			),
		]);
		await stub.handleDiscordMessage(say(a));
		const entity = await entityOf(a);
		const [existing] = await rowsOf(entity);

		const ignored = await stub.handleDiscordMessage(say(a));
		expect(ignored.action).toBe("ignore");
		expect(ignored.audit.openLoops).toBeNull();
		expect(await rowsOf(entity)).toHaveLength(1);
		expect(existing?.status).toBe("open");
	});

	it("ignore のターンで resolved_open_loop_ids が来ても解決しない", async () => {
		const a = newAuthor();
		const { stub } = await setup("ol-ignore-resolve", [
			llmOk(turn({ open_loops: [loop()] })),
		]);
		await stub.handleDiscordMessage(say(a));
		const entity = await entityOf(a);
		const [existing] = await rowsOf(entity);
		const { stub: stub2 } = await setup("ol-ignore-resolve", [
			llmOk(
				turn({
					reply_policy: "ignore",
					messages: [],
					resolved_open_loop_ids: [existing?.id ?? ""],
				}),
			),
		]);
		await stub2.handleDiscordMessage(say(a));
		expect((await rowsOf(entity))[0]?.status).toBe("open");
	});

	it("LLM 障害（degraded）のターンでは何も書かない", async () => {
		const a = newAuthor();
		const { stub } = await setup("ol-degraded", [transientFailure()]);
		const res = await stub.handleDiscordMessage(say(a));
		expect(res.audit.degraded).toBe(true);
		expect(res.audit.openLoops).toBeNull();
		const entity = await entityOf(a);
		expect(await rowsOf(entity)).toHaveLength(0);
	});
});

describe("Open Loop の解決", () => {
	it("LLM が返した id のうち、話し相手自身の open な行だけ resolved にする", async () => {
		const a = newAuthor("alice");
		const b = newAuthor("bob");
		const { stub } = await setup("ol-resolve", [
			llmOk(turn()),
			llmOk(turn()),
			llmOk(turn()),
		]);
		// entity を作るため、各人が 1 度ずつ話す。
		await stub.handleDiscordMessage(say(a));
		await stub.handleDiscordMessage(say(b));
		const ea = await entityOf(a);
		const eb = await entityOf(b);
		await seedLoop(ea, "ol-a-open");
		await seedLoop(eb, "ol-b-open");
		await seedLoop(eb, "ol-b-dropped", { status: "dropped" });

		await runInDurableObject(stub, (o) => {
			o.createRouter = () =>
				new ModelRouter({
					provider: new FakeLLMProvider([
						llmOk(
							turn({
								resolved_open_loop_ids: [
									"ol-a-open",
									"ol-b-open",
									"ol-b-dropped",
									"ol-nonexistent",
								],
							}),
						),
					]),
				});
		});
		const res = await stub.handleDiscordMessage(say(b, "面接受かったよ"));
		expect(res.audit.openLoops).toMatchObject({
			added: [],
			resolved: ["ol-b-open"],
		});

		const byId = async (id: string) =>
			env.DB.prepare(
				"SELECT status, resolved_at, updated_at FROM open_loops WHERE id = ?",
			)
				.bind(id)
				.first<{
					status: string;
					resolved_at: string | null;
					updated_at: string;
				}>();
		expect(await byId("ol-a-open")).toMatchObject({ status: "open" });
		expect(await byId("ol-b-dropped")).toMatchObject({ status: "dropped" });
		expect(await byId("ol-b-open")).toEqual({
			status: "resolved",
			resolved_at: "2026-10-11T03:00:00.000Z",
			updated_at: "2026-10-11T03:00:00.000Z",
		});
	});

	it("prompt には open だけを重要度の高い順に最大 5 件、id 付きで入れる", async () => {
		const a = newAuthor();
		const { stub, fake } = await setup("ol-prompt", [
			llmOk(turn()),
			llmOk(turn()),
		]);
		await stub.handleDiscordMessage(say(a));
		const entity = await entityOf(a);
		for (let i = 0; i < 6; i++) {
			await seedLoop(entity, `p${i}`, { importance: 0.1 + i * 0.1 });
		}
		await seedLoop(entity, "p-resolved", { importance: 1, status: "resolved" });

		await stub.handleDiscordMessage(say(a));
		const block = loopsBlock(fake.requests[1]);
		const ids = [...block.matchAll(/\[(p[^\]]+)\]/g)].map((m) => m[1]);
		expect(ids).toEqual(["p5", "p4", "p3", "p2", "p1"]);
	});
});
