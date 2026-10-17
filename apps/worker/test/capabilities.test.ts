import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
	PENDING_TTL_MS,
	type PendingOperation,
	type PendingStore,
} from "@yunomi/capabilities";
import { FakeLLMProvider, ModelRouter, type StepRequest } from "@yunomi/llm";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import { describe, expect, it } from "vitest";
import {
	type CapabilityEnv,
	defaultCapabilities,
} from "../src/capabilities.ts";
import { createPendingStore } from "../src/do/pending-store.ts";
import { inbound, partnerStub } from "./helpers.ts";
import { final, toolUse } from "./llm-fixtures.ts";

const OWNER = "u1";
const BOT = env.PARTNER_DISCORD_USER_ID;
const T0 = new Date("2026-10-11T03:00:00Z");

const fullEnv = {
	GOOGLE_CLIENT_ID: "client-id",
	GOOGLE_CLIENT_SECRET: "client-secret",
	GOOGLE_REFRESH_TOKEN: "refresh-token",
	GOOGLE_CALENDAR_ID: "owner@example.com",
	OWNER_DISCORD_USER_ID: OWNER,
} satisfies CapabilityEnv;
const placesEnv = {
	GOOGLE_PLACES_API_KEY: "places-key",
} satisfies CapabilityEnv;

const inertStore: PendingStore = {
	listOpen: async () => [],
	get: async () => null,
	save: async () => undefined,
};

const baseDeps = {
	pending: inertStore,
	policy: yukarinProfile.capability_defaults,
	now: () => T0,
};

describe("defaultCapabilities", () => {
	it("5 つが揃えば、カレンダーの道具と保留の了承・取り消しを持つ", () => {
		const caps = defaultCapabilities(fullEnv, baseDeps);
		expect(caps?.gate.definitions.map((d) => d.name)).toEqual([
			"calendar_list_events",
			"calendar_create_event",
			"pending_confirm",
			"pending_cancel",
		]);
	});

	it.each(Object.keys(fullEnv) as (keyof typeof fullEnv)[])(
		"%s が欠けていれば null（道具なし）",
		(key) => {
			const { [key]: _omitted, ...rest } = fullEnv;
			expect(defaultCapabilities(rest, baseDeps)).toBeNull();
		},
	);

	it.each(Object.keys(fullEnv) as (keyof typeof fullEnv)[])(
		"%s が空文字でも null",
		(key) => {
			expect(
				defaultCapabilities({ ...fullEnv, [key]: "" }, baseDeps),
			).toBeNull();
		},
	);

	it("Places の API キーだけなら、場所の検索だけを持つ（カレンダーの道具は無い）", () => {
		const caps = defaultCapabilities(placesEnv, baseDeps);
		expect(caps?.gate.definitions.map((d) => d.name)).toEqual([
			"place_search",
			"pending_confirm",
			"pending_cancel",
		]);
		expect(caps?.isOwner(OWNER)).toBe(false);
	});

	it("カレンダーの認証情報と Places の API キーが両方あれば、両方の道具を持つ", () => {
		const caps = defaultCapabilities({ ...fullEnv, ...placesEnv }, baseDeps);
		expect(caps?.gate.definitions.map((d) => d.name)).toEqual([
			"calendar_list_events",
			"calendar_create_event",
			"place_search",
			"pending_confirm",
			"pending_cancel",
		]);
		expect(caps?.isOwner(OWNER)).toBe(true);
	});

	it("Places の API キーが空文字なら null", () => {
		expect(
			defaultCapabilities({ GOOGLE_PLACES_API_KEY: "" }, baseDeps),
		).toBeNull();
	});

	it("何も無ければ null", () => {
		expect(defaultCapabilities({}, baseDeps)).toBeNull();
	});

	it("isOwner は OWNER_DISCORD_USER_ID と一致する発言者だけ", () => {
		const caps = defaultCapabilities(fullEnv, baseDeps);
		expect(caps?.isOwner(OWNER)).toBe(true);
		expect(caps?.isOwner("u2")).toBe(false);
		expect(caps?.isOwner("")).toBe(false);
	});

	it("テストの環境（secret なし）の PartnerDO は道具を持たない", async () => {
		await runInDurableObject(partnerStub("no-secrets"), (o) => {
			expect(o.capabilities).toBeUndefined();
		});
	});
});

type FetchCall = { url: URL; init: RequestInit };

// Google の token endpoint と Calendar API の代わり。呼ばれた順に記録する。
const fakeGoogle = () => {
	const calls: FetchCall[] = [];
	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = new URL(String(input));
		calls.push({ url, init: init ?? {} });
		if (url.hostname === "oauth2.googleapis.com") {
			return json({ access_token: "tok-1", expires_in: 3600 });
		}
		if (init?.method === "POST") {
			return json({
				id: "c0100000000000000002",
				htmlLink: "https://calendar.google.com/event?eid=x",
			});
		}
		return json({
			items: [
				{
					summary: "歯医者",
					start: { dateTime: "2026-10-12T19:00:00+09:00" },
					end: { dateTime: "2026-10-12T20:00:00+09:00" },
				},
			],
		});
	}) as typeof fetch;
	return {
		calls,
		fetchFn,
		eventCalls: () =>
			calls.filter((c) => c.url.hostname === "www.googleapis.com"),
	};
};

const listInput = {
	from: "2026-10-12T00:00:00+09:00",
	to: "2026-10-13T00:00:00+09:00",
};
const createInput = {
	summary: "歯医者",
	start: "2026-10-12T19:00:00+09:00",
	end: "2026-10-12T20:00:00+09:00",
	description: null,
};

const ask = (messageId: string, text: string) =>
	inbound({ messageId, mentionedUserIds: [BOT], content: text });

const systemText = (req: StepRequest<unknown> | undefined) =>
	(req?.system ?? []).map((b) => b.text).join("\n");

/** DO の SQLite の保留と、Google の fake を組み合わせた defaultCapabilities を PartnerDO に差し込む。 */
const setup = async (name: string) => {
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider();
	const google = fakeGoogle();
	const clock = { now: T0 };
	await runInDurableObject(stub, (o, st) => {
		o.now = () => clock.now;
		o.createRouter = () => new ModelRouter({ provider: fake });
		o.capabilities =
			defaultCapabilities(fullEnv, {
				pending: createPendingStore(st.storage.sql),
				policy: yukarinProfile.capability_defaults,
				now: () => clock.now,
				fetch: google.fetchFn,
			}) ?? undefined;
	});
	// DO の storage は、その DO の文脈の中でしか触れない。
	const inDo = <T>(
		fn: (sql: SqlStorage, store: PendingStore) => Promise<T> | T,
	) =>
		runInDurableObject(stub, (_o, st) =>
			fn(st.storage.sql, createPendingStore(st.storage.sql)),
		);
	const rows = () =>
		inDo((sql) =>
			sql
				.exec<{
					id: string;
					status: string;
					resolved_at: string | null;
				}>(
					"SELECT id, status, resolved_at FROM pending_operations ORDER BY rowid",
				)
				.toArray(),
		);
	const save = (ops: readonly PendingOperation[]) =>
		inDo((_sql, store) => store.save(ops));
	const listOpen = () => inDo((_sql, store) => store.listOpen("yukarin", "c1"));
	return { stub, fake, google, clock, rows, save, listOpen };
};

describe("Worker 上での組み立て（DO SQLite の保留と Google の fake）", () => {
	it("確認: owner の依頼で、オーナーのカレンダーを認証付きで読んでから答える", async () => {
		const { stub, fake, google, rows } = await setup("wiring-list");
		fake.enqueueStep(
			toolUse([{ name: "calendar_list_events", input: listInput }]),
			final("明日は 19 時から歯医者ですよ"),
		);
		const res = await stub.handleDiscordMessage(
			ask("100000000000000001", "明日の予定ある？"),
		);

		expect(res).toMatchObject({
			action: "reply",
			messages: [{ content: "明日は 19 時から歯医者ですよ" }],
		});
		const [tokenCall, listCall] = google.calls;
		expect(tokenCall?.url.href).toBe("https://oauth2.googleapis.com/token");
		expect(String(tokenCall?.init.body)).toContain(
			"refresh_token=refresh-token",
		);
		expect(listCall?.url.pathname).toBe(
			"/calendar/v3/calendars/owner%40example.com/events",
		);
		expect(listCall?.init.headers).toMatchObject({
			authorization: "Bearer tok-1",
		});
		expect(res.audit.toolCalls[0]).toMatchObject({
			tool: "calendar_list_events",
			decision: "auto",
			outcome: "ok",
		});
		expect(await rows()).toEqual([]);
	});

	it("登録: 提案では Google に書かず保留を SQLite に残し、了承で元の発言の ID で登録する", async () => {
		const { stub, fake, google, rows } = await setup("wiring-create");
		fake.enqueueStep(
			toolUse([{ name: "calendar_create_event", input: createInput }]),
			final("12日 19:00 から歯医者、で入れていい？"),
		);
		const proposed = await stub.handleDiscordMessage(
			ask("100000000000000002", "明日19時に歯医者入れて"),
		);
		expect(proposed.audit.toolCalls[0]).toMatchObject({
			decision: "confirm",
			outcome: "pending",
		});
		expect(google.calls).toHaveLength(0);
		const [pending] = await rows();
		expect(pending).toMatchObject({ status: "proposed", resolved_at: null });

		fake.enqueueStep(
			toolUse([
				{ name: "pending_confirm", input: { pending_id: pending?.id } },
			]),
			final("入れました"),
		);
		const confirmed = await stub.handleDiscordMessage(
			ask("100000000000000003", "うん"),
		);
		expect(systemText(fake.stepRequests[2])).toContain(`[${pending?.id}]`);
		expect(confirmed.audit.toolCalls[0]).toMatchObject({
			decision: "pending_confirm",
			outcome: "ok",
			pendingId: pending?.id,
		});
		const post = google.eventCalls().find((c) => c.init.method === "POST");
		expect(JSON.parse(String(post?.init.body))).toMatchObject({
			id: "c0100000000000000002",
			summary: "歯医者",
		});
		expect(await rows()).toEqual([
			{ id: pending?.id, status: "executed", resolved_at: T0.toISOString() },
		]);
	});

	it("取り消し: 保留が cancelled になり、Google には何も書かれない", async () => {
		const { stub, fake, google, rows } = await setup("wiring-cancel");
		fake.enqueueStep(
			toolUse([{ name: "calendar_create_event", input: createInput }]),
			final("入れていい？"),
		);
		await stub.handleDiscordMessage(
			ask("100000000000000004", "明日19時に歯医者入れて"),
		);
		const [pending] = await rows();
		fake.enqueueStep(
			toolUse([{ name: "pending_cancel", input: { pending_id: pending?.id } }]),
			final("やめておきますね"),
		);
		await stub.handleDiscordMessage(
			ask("100000000000000005", "やっぱりやめて"),
		);
		expect((await rows()).map((r) => r.status)).toEqual(["cancelled"]);
		expect(google.calls).toHaveLength(0);
	});
});

describe("期限切れの保留の保存", () => {
	it("ターンで一覧を読むとき、期限を過ぎた proposed だけを expired にして保存する", async () => {
		const { stub, fake, clock, rows, save, listOpen } =
			await setup("wiring-expire");
		const base = {
			partnerId: "yukarin",
			channelId: "c1",
			tool: "calendar_create_event",
			input: createInput,
			requestedBy: OWNER,
			sourceMessageId: "100000000000000006",
			status: "proposed",
			resolvedAt: null,
		} as const;
		const stale = {
			...base,
			id: "stale",
			createdAt: T0.toISOString(),
			expiresAt: new Date(T0.getTime() + PENDING_TTL_MS).toISOString(),
		};
		const fresh = {
			...base,
			id: "fresh",
			createdAt: new Date(T0.getTime() + PENDING_TTL_MS).toISOString(),
			expiresAt: new Date(T0.getTime() + 2 * PENDING_TTL_MS).toISOString(),
		};
		await save([stale, fresh]);

		clock.now = new Date(T0.getTime() + PENDING_TTL_MS + 1000);
		fake.enqueueStep(final("はい"));
		await stub.handleDiscordMessage(ask("100000000000000007", "こんにちは"));

		expect(await rows()).toEqual([
			{
				id: "stale",
				status: "expired",
				resolved_at: clock.now.toISOString(),
			},
			{ id: "fresh", status: "proposed", resolved_at: null },
		]);
		const prompt = systemText(fake.stepRequests[0]);
		expect(prompt).toContain("[fresh]");
		expect(prompt).not.toContain("[stale]");
		expect(await listOpen()).toEqual([fresh]);
	});

	it("期限ちょうどの保留も expired にする", async () => {
		const { stub, fake, clock, rows, save } = await setup("wiring-boundary");
		await save([
			{
				id: "edge",
				partnerId: "yukarin",
				channelId: "c1",
				tool: "calendar_create_event",
				input: createInput,
				requestedBy: OWNER,
				sourceMessageId: "100000000000000008",
				createdAt: T0.toISOString(),
				expiresAt: new Date(T0.getTime() + PENDING_TTL_MS).toISOString(),
				status: "proposed",
				resolvedAt: null,
			},
		]);
		clock.now = new Date(T0.getTime() + PENDING_TTL_MS);
		fake.enqueueStep(final("はい"));
		await stub.handleDiscordMessage(ask("100000000000000009", "こんにちは"));
		expect((await rows()).map((r) => r.status)).toEqual(["expired"]);
	});
});
