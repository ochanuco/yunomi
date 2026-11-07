import { env } from "cloudflare:workers";
import { newId } from "@yunomi/core";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { handleConversationLogDelete } from "../src/admin/conversation-log.ts";
import worker from "../src/index.ts";
import { rebuildChannelChunks } from "../src/memory-index/chunks.ts";
import { searchKeywords } from "../src/memory-index/keyword.ts";
import { PARTNER_ID } from "./helpers.ts";

const db = drizzle(env.DB);
const NOW = new Date("2026-11-07T19:17:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

// Workers AI と Vectorize の binding の代わり。vectorDepsFromEnv がそのまま包む。
const fakeBindings = (opts: { failDelete?: boolean } = {}) => {
	const vectors = new Map<string, VectorizeVector>();
	const deleted: string[] = [];
	const AI = {
		run: async (_model: string, input: { text: string[] }) => ({
			data: input.text.map((t) => [t.length, 0, 0]),
		}),
	};
	const MEMORY_INDEX = {
		upsert: async (vs: VectorizeVector[]) => {
			for (const v of vs) vectors.set(v.id, v);
		},
		deleteByIds: async (ids: string[]) => {
			if (opts.failDelete) throw new Error("vectorize down");
			for (const id of ids) {
				vectors.delete(id);
				deleted.push(id);
			}
		},
		query: async () => ({ matches: [] }),
	};
	return { bindings: { AI, MEMORY_INDEX }, vectors, deleted };
};

// 持ち主の発言 -> 返事 -> 持ち主の発言 -> 返事 の 2 つの塊を作る。
const seedConversation = async (ownerId: string, base: Date) => {
	const channelId = `cli-${newId()}`;
	const word = `話題${newId().slice(-6)}`;
	const at = (minute: number) =>
		new Date(base.getTime() + minute * 60_000).toISOString();
	const rows = [
		{
			id: newId(),
			author: ownerId,
			partner: false,
			text: `${word}の最初`,
			at: at(0),
		},
		{
			id: newId(),
			author: "bot",
			partner: true,
			text: "最初の返事",
			at: at(1),
		},
		{
			id: newId(),
			author: ownerId,
			partner: false,
			text: "次の発言",
			at: at(2),
		},
		{ id: newId(), author: "bot", partner: true, text: "次の返事", at: at(3) },
	];
	await env.DB.batch(
		rows.map((r) =>
			env.DB.prepare(
				"INSERT INTO conversation_messages (id, partner_id, channel_id, message_id, discord_message_id, turn_event_id, author_id, author_name, is_bot, is_partner, content, occurred_at, logged_at) VALUES (?1, ?2, ?3, ?4, NULL, 'turn', ?5, 'name', ?6, ?6, ?7, ?8, ?8)",
			).bind(
				r.id,
				PARTNER_ID,
				channelId,
				`m-${r.id}`,
				r.author,
				r.partner ? 1 : 0,
				r.text,
				r.at,
			),
		),
	);
	const built = await rebuildChannelChunks(db, {
		partnerId: PARTNER_ID,
		channelId,
		ownerId,
	});
	if (!built.ok) throw new Error(built.error.type);
	return { channelId, word, rows, anchors: [rows[0]?.id, rows[2]?.id] };
};

const chunkIds = async (channelId: string) =>
	(
		await env.DB.prepare(
			"SELECT id FROM conversation_chunks WHERE channel_id = ? ORDER BY occurred_at",
		)
			.bind(channelId)
			.all<{ id: string }>()
	).results.map((r) => r.id);

const messageCount = async (channelId: string) =>
	(
		await env.DB.prepare(
			"SELECT count(*) AS n FROM conversation_messages WHERE channel_id = ?",
		)
			.bind(channelId)
			.first<{ n: number }>()
	)?.n;

const hits = async (text: string) => {
	const r = await searchKeywords(db, { partnerId: PARTNER_ID, text, topK: 10 });
	if (!r.ok) throw new Error(r.error.type);
	return r.value.length;
};

const adminDelete = (body: unknown, e: Record<string, unknown>) =>
	handleConversationLogDelete(
		new Request("http://localhost/", {
			method: "POST",
			body: JSON.stringify(body),
		}),
		e as unknown as Env,
		PARTNER_ID,
		{ kind: "owner", email: "owner@example.com" },
		NOW,
	);

describe("会話ログの削除と索引", () => {
	it("Admin API の削除で、塊を消すか作り直し、FTS5 と Vectorize からも消す", async () => {
		const c = await seedConversation(`owner-${newId()}`, NOW);
		const f = fakeBindings();
		const [a1, a2] = c.anchors;
		expect(await chunkIds(c.channelId)).toEqual([a1, a2]);
		expect(await hits(c.word)).toBe(2);

		const res = await adminDelete(
			{ message_ids: [`m-${a1}`] },
			{ ...env, ...f.bindings },
		);
		expect(await res.json()).toEqual({ dry_run: false, count: 1 });
		expect(await chunkIds(c.channelId)).toEqual([a2]);
		expect(await hits(c.word)).toBe(0);
		expect(f.deleted).toContain(`conversation:${a1}`);
		expect(f.vectors.has(`conversation:${a2}`)).toBe(true);
	});

	it("dry-run では索引に触れない", async () => {
		const c = await seedConversation(`owner-${newId()}`, NOW);
		const f = fakeBindings();
		await adminDelete(
			{ channel_id: c.channelId, dry_run: true },
			{ ...env, ...f.bindings },
		);
		expect(await chunkIds(c.channelId)).toHaveLength(2);
		expect(f.deleted).toEqual([]);
	});

	it("Vectorize から消せなければ会話ログを消さず 503", async () => {
		const c = await seedConversation(`owner-${newId()}`, NOW);
		const f = fakeBindings({ failDelete: true });
		const res = await adminDelete(
			{ channel_id: c.channelId },
			{ ...env, ...f.bindings },
		);
		expect(res.status).toBe(503);
		expect(await res.json()).toEqual({ error: "index_failed" });
		expect(await messageCount(c.channelId)).toBe(4);
	});

	it("日次 cron の保持期間切れ削除でも、消した発言を索引から外す", async () => {
		// 持ち主が替わると、前の持ち主の発言は他人の発言として 90 日で消える。
		const formerOwner = `former-${newId()}`;
		const c = await seedConversation(
			formerOwner,
			new Date(NOW.getTime() - 100 * DAY),
		);
		const f = fakeBindings();
		await worker.scheduled(
			{ scheduledTime: NOW.getTime(), cron: "17 19 * * *", noRetry() {} },
			{
				...env,
				...f.bindings,
				OWNER_DISCORD_USER_ID: `owner-${newId()}`,
			} as unknown as Env,
		);
		expect(await messageCount(c.channelId)).toBe(2);
		expect(await chunkIds(c.channelId)).toEqual([]);
		expect(f.deleted).toEqual(
			expect.arrayContaining(c.anchors.map((id) => `conversation:${id}`)),
		);
	});
});
