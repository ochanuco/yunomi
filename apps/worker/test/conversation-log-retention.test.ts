import { env, exports } from "cloudflare:workers";
import {
	CONVERSATION_LOG_DELETE_MAX_MESSAGE_IDS,
	ConversationLogDeleteResponseSchema,
} from "@yunomi/admin-contract";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteConversationMessages } from "../src/conversation-log.ts";
import worker from "../src/index.ts";
import { PARTNER_ID } from "./helpers.ts";

const OWNER = "owner-discord-id";
const NOW = new Date("2026-11-07T19:17:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

type Seed = {
	id: string;
	authorId?: string;
	isPartner?: boolean;
	channelId?: string;
	discordMessageId?: string | null;
	occurredAt: string;
};

const insert = (rows: Seed[]) =>
	env.DB.batch(
		rows.map((r) =>
			env.DB.prepare(
				"INSERT INTO conversation_messages (id, partner_id, channel_id, message_id, discord_message_id, turn_event_id, author_id, author_name, is_bot, is_partner, content, occurred_at, logged_at) VALUES (?1, ?2, ?3, ?4, ?5, 'turn', ?6, 'name', ?7, ?7, '本文', ?8, ?8)",
			).bind(
				r.id,
				PARTNER_ID,
				r.channelId ?? "c1",
				`m-${r.id}`,
				r.discordMessageId ?? null,
				r.authorId ?? "someone",
				r.isPartner ? 1 : 0,
				r.occurredAt,
			),
		),
	);

const ids = async () =>
	(
		await env.DB.prepare(
			"SELECT id FROM conversation_messages WHERE partner_id = ? ORDER BY id",
		)
			.bind(PARTNER_ID)
			.all<{ id: string }>()
	).results.map((r) => r.id);

const maintenance = async () =>
	(
		await env.DB.prepare(
			"SELECT * FROM maintenance_events WHERE partner_id = ? ORDER BY created_at",
		)
			.bind(PARTNER_ID)
			.all<Record<string, unknown>>()
	).results;

const runCron = (e: Record<string, unknown>) =>
	worker.scheduled(
		{ scheduledTime: NOW.getTime(), cron: "17 19 * * *", noRetry() {} },
		e as unknown as Env,
	);

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM conversation_messages"),
		env.DB.prepare("DELETE FROM maintenance_events"),
	]);
});

describe("会話ログの保持期間", () => {
	it("90 日を過ぎた他人の発言だけを消し、持ち主と Partner の発言は残す", async () => {
		await insert([
			{ id: "old-other", occurredAt: daysAgo(91) },
			{ id: "old-owner", authorId: OWNER, occurredAt: daysAgo(91) },
			{
				id: "old-partner",
				authorId: "bot",
				isPartner: true,
				occurredAt: daysAgo(91),
			},
			{ id: "new-other", occurredAt: daysAgo(89) },
		]);

		await runCron({ ...env, OWNER_DISCORD_USER_ID: OWNER });

		expect(await ids()).toEqual(["new-other", "old-owner", "old-partner"]);
		const events = await maintenance();
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			kind: "conversation_log_retention",
			actor: "cron",
			deleted_count: 1,
		});
		expect(Object.keys(events[0] ?? {})).not.toContain("content");
	});

	it("持ち主が分からなければ消さない", async () => {
		await insert([{ id: "old-other", occurredAt: daysAgo(200) }]);
		await runCron({ ...env });
		expect(await ids()).toEqual(["old-other"]);
		expect(await maintenance()).toEqual([]);
	});
});

describe("deleteConversationMessages", () => {
	it("dry-run は消さずに対象の id を返す", async () => {
		await insert([
			{ id: "a", occurredAt: daysAgo(3) },
			{ id: "b", occurredAt: daysAgo(1) },
		]);
		const r = await deleteConversationMessages(
			drizzle(env.DB),
			{ partnerId: PARTNER_ID, to: daysAgo(2) },
			{ dryRun: true },
		);
		expect(r).toEqual({ ok: true, value: { ids: ["a"] } });
		expect(await ids()).toEqual(["a", "b"]);
	});

	it("条件が無ければ消さない", async () => {
		await insert([{ id: "a", occurredAt: daysAgo(3) }]);
		const r = await deleteConversationMessages(
			drizzle(env.DB),
			{ partnerId: PARTNER_ID },
			{ dryRun: false },
		);
		expect(r).toEqual({ ok: false, error: { type: "empty_criteria" } });
		expect(await ids()).toEqual(["a"]);
	});
});

const asYkm = { "x-yunomi-dev-caller": "ykm" };
const del = (body: unknown, headers: Record<string, string> = asYkm) =>
	exports.default.fetch(
		new Request(
			`http://localhost/admin/api/partners/${PARTNER_ID}/conversation-log/delete`,
			{
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		),
	);

describe("POST /conversation-log/delete", () => {
	beforeEach(() =>
		insert([
			{ id: "a", channelId: "c1", occurredAt: "2026-10-01T00:00:00.000Z" },
			{
				id: "b",
				channelId: "c2",
				discordMessageId: "d-b",
				authorId: OWNER,
				occurredAt: "2026-10-02T00:00:00.000Z",
			},
			{ id: "c", channelId: "c1", occurredAt: "2026-10-03T00:00:00.000Z" },
		]),
	);

	it("期間で消し、件数を返して maintenance_events に件数だけを残す", async () => {
		const res = await del({
			from: "2026-10-01T09:00:00+09:00",
			to: "2026-10-03T00:00:00Z",
		});
		expect(res.status).toBe(200);
		expect(
			v.parse(ConversationLogDeleteResponseSchema, await res.json()),
		).toEqual({ dry_run: false, count: 2 });
		expect(await ids()).toEqual(["c"]);
		const [event] = await maintenance();
		expect(event).toMatchObject({
			kind: "conversation_log_delete",
			actor: "ykm",
			deleted_count: 2,
		});
	});

	it("dry_run は件数だけを返し、消さず記録もしない", async () => {
		const res = await del({ channel_id: "c1", dry_run: true });
		expect(await res.json()).toEqual({ dry_run: true, count: 2 });
		expect(await ids()).toEqual(["a", "b", "c"]);
		expect(await maintenance()).toEqual([]);
	});

	it("メッセージ ID は message_id と discord_message_id のどちらでも当たる", async () => {
		const res = await del({ message_ids: ["m-a", "d-b"] });
		expect(await res.json()).toEqual({ dry_run: false, count: 2 });
		expect(await ids()).toEqual(["c"]);
	});

	it("チャンネルと期間は両方を満たす行だけを消す", async () => {
		const res = await del({ channel_id: "c1", to: "2026-10-02T00:00:00Z" });
		expect(await res.json()).toEqual({ dry_run: false, count: 1 });
		expect(await ids()).toEqual(["b", "c"]);
	});

	it.each([
		[{}, "empty_criteria"],
		[{ from: "2026-10-01" }, "validation_failed"],
		[
			{ from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" },
			"invalid_range",
		],
		[{ channel_id: "c1", extra: 1 }, "validation_failed"],
		[
			{
				message_ids: Array.from(
					{ length: CONVERSATION_LOG_DELETE_MAX_MESSAGE_IDS + 1 },
					(_, i) => `m${i}`,
				),
			},
			"validation_failed",
		],
	])("不正な要求 %j は 400 %s", async (body, error) => {
		const res = await del(body);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error });
		expect(await ids()).toEqual(["a", "b", "c"]);
	});

	it("gateway からは 403", async () => {
		const res = await del(
			{ channel_id: "c1" },
			{ "x-yunomi-dev-caller": "gateway" },
		);
		expect(res.status).toBe(403);
		expect(await ids()).toEqual(["a", "b", "c"]);
	});

	it("POST 以外は 405", async () => {
		const res = await exports.default.fetch(
			new Request(
				`http://localhost/admin/api/partners/${PARTNER_ID}/conversation-log/delete`,
				{ headers: asYkm },
			),
		);
		expect(res.status).toBe(405);
	});
});
