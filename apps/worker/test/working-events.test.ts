import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { PendingStore } from "@yunomi/capabilities";
import { FakeLLMProvider, ModelRouter, type StepRequest } from "@yunomi/llm";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultCapabilities } from "../src/capabilities.ts";
import { createGoalStore } from "../src/work-notes.ts";
import {
	createWorkingEventRepo,
	purgeFinishedWorkingEvents,
	WORKING_EVENT_PROMPT_LIMIT,
} from "../src/working-events.ts";
import { inbound, PARTNER_ID, partnerStub } from "./helpers.ts";
import { final } from "./llm-fixtures.ts";

const BOT = env.PARTNER_DISCORD_USER_ID;
const T0 = new Date("2026-11-22T03:00:00Z");
const URL_EVENTS = `http://localhost/v1/partners/${PARTNER_ID}/working/events`;
const working = { "x-yunomi-dev-caller": "working" };

const post = (
	body: unknown,
	headers: Record<string, string> = working,
	url = URL_EVENTS,
) =>
	exports.default.fetch(
		new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		}),
	);

const event = (over: Record<string, unknown> = {}) => ({
	thread_id: "1300000000000000001",
	title: "請求書の下書き",
	event: "started",
	status: null,
	summary: null,
	at: "2026-11-22T12:00:00+09:00",
	...over,
});

const rows = async () =>
	(
		await env.DB.prepare(
			"SELECT partner_id, thread_id, title, event, status, summary, at FROM working_events ORDER BY thread_id",
		).all()
	).results;

// 席の行は partner ごとに持つので、話し相手を変えても前のテストの行が見える。テストごとに空にする。
beforeEach(async () => {
	await env.DB.prepare("DELETE FROM working_events").run();
});

describe("出来事の口", () => {
	it("working の service だけが使え、POST 以外は 405", async () => {
		expect((await post(event(), {})).status).toBe(401);
		for (const caller of ["gateway", "voice", "ykm"]) {
			expect(
				(await post(event(), { "x-yunomi-dev-caller": caller })).status,
			).toBe(403);
		}
		const get = await exports.default.fetch(
			new Request(URL_EVENTS, { headers: working }),
		);
		expect(get.status).toBe(405);
		expect(await rows()).toEqual([]);
	});

	it("知らない partner は 404", async () => {
		const res = await post(
			event(),
			working,
			"http://localhost/v1/partners/nobody/working/events",
		);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "unknown_partner" });
	});

	it("形に合わない本文は 400 で、何も残さない", async () => {
		const bad = [
			event({ thread_id: "abc" }),
			event({ title: "" }),
			event({ title: "a".repeat(101) }),
			event({ title: "一行目\n二行目" }),
			event({ event: "paused" }),
			event({ event: "done", status: null }),
			event({ event: "started", status: "完了" }),
			event({ event: "done", status: "保留" }),
			event({ summary: "a".repeat(201) }),
			event({ summary: "一行目\n二行目" }),
			event({ at: "2026-11-22T12:00:00" }),
			event({ at: "昨日" }),
		];
		for (const body of bad) {
			const res = await post(body);
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect(
				((await res.json()) as { error: string }).error,
				JSON.stringify(body),
			).toBe("validation_failed");
		}
		expect(await rows()).toEqual([]);
	});

	it("席ごとに最新の 1 件を持ち、時刻は UTC で残す", async () => {
		expect((await post(event({ summary: "先月分を作る" }))).status).toBe(204);
		expect(
			(
				await post(
					event({
						event: "asking",
						summary: "宛名は会社名でいいか",
						at: "2026-11-22T12:10:00+09:00",
					}),
				)
			).status,
		).toBe(204);
		expect(
			(
				await post(
					event({
						event: "done",
						status: "完了",
						summary: "下書きを投稿に置いた",
						at: "2026-11-22T12:30:00+09:00",
					}),
				)
			).status,
		).toBe(204);
		expect(await rows()).toEqual([
			{
				partner_id: PARTNER_ID,
				thread_id: "1300000000000000001",
				title: "請求書の下書き",
				event: "done",
				status: "完了",
				summary: "下書きを投稿に置いた",
				at: "2026-11-22T03:30:00.000Z",
			},
		]);

		// 同じ席がまた動き出したら、前の status と要旨は消える
		expect(
			(await post(event({ at: "2026-11-22T13:00:00+09:00" }))).status,
		).toBe(204);
		expect(await rows()).toMatchObject([
			{ event: "started", status: null, summary: null },
		]);
	});

	it("持っている出来事より古い出来事は 204 で捨てる", async () => {
		await post(
			event({
				event: "failed",
				summary: "権限が無い",
				at: "2026-11-22T03:20:00Z",
			}),
		);
		const res = await post(
			event({
				event: "asking",
				summary: "古い質問",
				at: "2026-11-22T03:10:00Z",
			}),
		);
		expect(res.status).toBe(204);
		expect(await rows()).toMatchObject([
			{ event: "failed", summary: "権限が無い" },
		]);
	});
});

describe("席の出来事の置き場所", () => {
	const repo = () => createWorkingEventRepo(drizzle(env.DB));
	const put = (threadId: string, ev: string, at: Date, status?: string) =>
		repo().record({
			partnerId: PARTNER_ID,
			threadId,
			title: `件名 ${threadId}`,
			event: ev as "started",
			status: (status ?? null) as null,
			summary: null,
			at,
			now: T0,
		});
	const hoursAgo = (h: number) => new Date(T0.getTime() - h * 3_600_000);

	it("動いている席と判断待ちの席、1 日以内に終わった席を新しい順に 5 件まで", async () => {
		await put("1", "started", hoursAgo(72));
		await put("2", "asking", hoursAgo(30));
		await put("3", "done", hoursAgo(25), "完了");
		await put("4", "failed", hoursAgo(23));
		await put("5", "done", hoursAgo(2), "見張り中");
		await put("6", "started", hoursAgo(1));
		await repo().record({
			partnerId: "akarin",
			threadId: "7",
			title: "別のパートナーの席",
			event: "started",
			status: null,
			summary: null,
			at: hoursAgo(0),
			now: T0,
		});

		const current = await repo().current(PARTNER_ID, T0);
		expect(current.map((e) => e.threadId)).toEqual(["6", "5", "4", "2", "1"]);
		expect(current).toHaveLength(WORKING_EVENT_PROMPT_LIMIT);

		await put("8", "started", hoursAgo(0.5));
		expect(
			(await repo().current(PARTNER_ID, T0)).map((e) => e.threadId),
		).toEqual(["8", "6", "5", "4", "2"]);
	});

	it("日次の掃除は、終わってから 7 日を過ぎた席だけを消す", async () => {
		await put("1", "done", hoursAgo(24 * 7 + 1), "完了");
		await put("2", "failed", hoursAgo(24 * 7 + 1));
		await put("3", "done", hoursAgo(24 * 7 - 1), "引き継ぎ");
		await put("4", "started", hoursAgo(24 * 30));
		await put("5", "asking", hoursAgo(24 * 30));

		expect(await purgeFinishedWorkingEvents(drizzle(env.DB), T0)).toBe(2);
		expect((await rows()).map((r) => r.thread_id)).toEqual(["3", "4", "5"]);
	});
});

describe("今の仕事", () => {
	const inertStore: PendingStore = {
		listOpen: async () => [],
		get: async () => null,
		save: async () => undefined,
	};
	const OWNER = {
		id: "working-events-owner",
		displayName: "alice",
		isBot: false,
	};

	const block = (req: StepRequest<unknown> | undefined) =>
		req?.system.find((b) => b.text.startsWith("## 今の仕事"))?.text;

	const setup = async (name: string) => {
		const stub = partnerStub(name);
		const fake = new FakeLLMProvider();
		await runInDurableObject(stub, (o) => {
			o.now = () => T0;
			o.createRouter = () => new ModelRouter({ provider: fake });
			o.capabilities =
				defaultCapabilities(
					{ OWNER_DISCORD_USER_ID: OWNER.id },
					{
						pending: inertStore,
						policy: yukarinProfile.capability_defaults,
						now: () => T0,
						// 道具が 1 つも無いと capabilities が付かず、オーナーを見分けられない
						goals: createGoalStore(drizzle(env.DB)),
					},
				) ?? undefined;
		});
		const say = (author = OWNER) =>
			stub.handleDiscordMessage(
				inbound({ author, mentionedUserIds: [BOT], content: "仕事どう？" }),
			);
		return { fake, say };
	};

	it("オーナーのターンにだけ、届いた席の出来事を出す", async () => {
		await post(
			event({
				event: "asking",
				summary: "宛名は会社名でいいか",
				at: "2026-11-22T02:00:00Z",
			}),
		);
		const { fake, say } = await setup("working-events-owner");
		fake.enqueueStep(final("宛名を聞かれてますよ"));
		await say();
		expect(block(fake.stepRequests[0])).toBe(
			[
				"## 今の仕事",
				"仕事の席（Working）で動いている仕事、オーナーの判断を待っている仕事と、この 1 日に終わった仕事。新しい順。聞かれたら、この一覧で答える。",
				"- 請求書の下書き（判断待ち、1 時間前）: 宛名は会社名でいいか",
			].join("\n"),
		);

		fake.enqueueStep(final("こんにちは"));
		const asked = fake.stepRequests.length;
		await say({ id: "working-events-other", displayName: "bob", isBot: false });
		expect(block(fake.stepRequests[asked])).toBeUndefined();
	});
});
