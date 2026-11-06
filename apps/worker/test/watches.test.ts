import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { PendingStore } from "@yunomi/capabilities";
import { FakeLLMProvider, ModelRouter, type StepRequest } from "@yunomi/llm";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { defaultCapabilities } from "../src/capabilities.ts";
import {
	ACTIVE_WATCH_LIMIT,
	createWatchRepo,
	createWatchStore,
	WATCH_SEEN_LIMIT,
} from "../src/watches.ts";
import { inbound, PARTNER_ID, partnerStub } from "./helpers.ts";
import { final, toolUse } from "./llm-fixtures.ts";

const BOT = env.PARTNER_DISCORD_USER_ID;
const T0 = new Date("2026-11-06T03:00:00Z");
const URL_MEMORY = `http://localhost/v1/partners/${PARTNER_ID}/working/memory`;
const working = { "x-yunomi-dev-caller": "working" };

const inertStore: PendingStore = {
	listOpen: async () => [],
	get: async () => null,
	save: async () => undefined,
};

// D1 はテスト間で巻き戻らないため、テストごとに別のオーナーを使う。
let seq = 0;
const newOwner = () => {
	seq += 1;
	return { id: `watch-owner-${seq}`, displayName: "alice", isBot: false };
};

const block = (req: StepRequest<unknown> | undefined, heading: string) =>
	req?.system.find((b) => b.text.startsWith(heading))?.text ?? "";

const setup = async (name: string) => {
	const owner = newOwner();
	const stub = partnerStub(name);
	const fake = new FakeLLMProvider();
	await runInDurableObject(stub, (o) => {
		o.now = () => T0;
		o.createRouter = () => new ModelRouter({ provider: fake });
		o.capabilities =
			defaultCapabilities(
				{ OWNER_DISCORD_USER_ID: owner.id },
				{
					pending: inertStore,
					policy: yukarinProfile.capability_defaults,
					now: () => T0,
					watches: createWatchStore(drizzle(env.DB)),
				},
			) ?? undefined;
	});
	const say = (content: string) =>
		stub.handleDiscordMessage(
			inbound({ author: owner, mentionedUserIds: [BOT], content }),
		);
	fake.enqueueStep(final("こんにちは"));
	await say("こんにちは");
	const entity = await env.DB.prepare(
		"SELECT entity_id FROM external_identities WHERE provider = 'discord' AND external_id = ?",
	)
		.bind(owner.id)
		.first<{ entity_id: string }>();
	return { owner, fake, say, entityId: entity?.entity_id as string };
};

type MemoryWatch = {
	id: string;
	query: string;
	sources: string[];
	interval_minutes: number;
	until_at: string | null;
	last_checked_at: string | null;
	due: boolean;
	seen: string[];
};

const readWatches = async (discordUserId: string) =>
	(
		(await (
			await exports.default.fetch(
				new Request(`${URL_MEMORY}?discord_user_id=${discordUserId}`, {
					headers: working,
				}),
			)
		).json()) as { watches: MemoryWatch[] }
	).watches;

const checked = (discordUserId: string, watchId: string, seen: string[]) =>
	exports.default.fetch(
		new Request(URL_MEMORY, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...working },
			body: JSON.stringify({
				discord_user_id: discordUserId,
				watch_id: watchId,
				seen,
			}),
		}),
	);

const addInput = {
	query: "RTX3090 の中古、24GB",
	sources: ["https://shop.example/gpu"],
	interval_hours: 6,
	until: "2026-12-31T23:59:00+09:00",
};

describe("見張りの道具", () => {
	it("会話で登録した見張りが、次のターンの「見張り」と Working の記憶に出る", async () => {
		const { owner, fake, say } = await setup("watch-add");
		fake.enqueueStep(
			toolUse([{ name: "watch_add", input: addInput }]),
			final("見張っておきますね"),
		);
		const res = await say("RTX3090 の中古、見張っといて");
		expect(res.audit.toolCalls[0]).toMatchObject({
			tool: "watch_add",
			decision: "auto",
			outcome: "ok",
		});
		expect(res.audit.toolCalls[0]?.summary).not.toContain("RTX");

		const [w] = await readWatches(owner.id);
		expect(w).toMatchObject({
			query: "RTX3090 の中古、24GB",
			sources: ["https://shop.example/gpu"],
			interval_minutes: 360,
			until_at: "2026-12-31 23:59 JST",
			last_checked_at: null,
			due: true,
			seen: [],
		});

		fake.enqueueStep(final("RTX3090 を見張っています"));
		const asked = fake.stepRequests.length;
		await say("何を見張ってるんだっけ");
		expect(block(fake.stepRequests[asked], "## 見張り")).toContain(
			`- [${w?.id}] RTX3090 の中古、24GB（https://shop.example/gpu、6 時間おき、2026-12-31 23:59 JST まで）`,
		);
	});

	it("会話で止めると一覧から消え、調べなくなる", async () => {
		const { owner, fake, say } = await setup("watch-stop");
		fake.enqueueStep(
			toolUse([{ name: "watch_add", input: { ...addInput, until: null } }]),
			final("はい"),
		);
		await say("見張って");
		const [w] = await readWatches(owner.id);
		fake.enqueueStep(
			toolUse([{ name: "watch_stop", input: { id: w?.id } }]),
			final("止めました"),
		);
		const res = await say("買えたから止めて");
		expect(res.audit.toolCalls[0]).toMatchObject({
			tool: "watch_stop",
			outcome: "ok",
		});
		expect(await readWatches(owner.id)).toEqual([]);
		expect((await checked(owner.id, w?.id as string, [])).status).toBe(404);
	});

	it("過去の期限では登録しない", async () => {
		const { owner, fake, say } = await setup("watch-past");
		fake.enqueueStep(
			toolUse([
				{
					name: "watch_add",
					input: { ...addInput, until: "2026-11-01T00:00:00+09:00" },
				},
			]),
			final("期限が過ぎています"),
		);
		const res = await say("先週まで見張って");
		expect(res.audit.toolCalls[0]?.outcome).toBe("error");
		expect(await readWatches(owner.id)).toEqual([]);
	});
});

describe("見張りの記録", () => {
	it("調べ終えると間隔が過ぎるまで due にならず、知らせたものを重ねずに覚える", async () => {
		const { owner, entityId } = await setup("watch-check");
		const repo = createWatchRepo(drizzle(env.DB));
		const added = await repo.add({
			partnerId: PARTNER_ID,
			entityId,
			query: "中古の万年筆",
			sources: [],
			intervalMinutes: 360,
			untilAt: null,
			now: T0,
		});
		const id = added.ok ? added.value.id : "";

		const res = await checked(owner.id, id, ["https://a.example/1"]);
		expect(res.status).toBe(200);
		const [w] = await readWatches(owner.id);
		expect(w?.due).toBe(false);
		expect(w?.seen).toEqual(["https://a.example/1"]);

		await checked(owner.id, id, ["https://a.example/1", "https://a.example/2"]);
		const later = new Date(Date.now() + 6 * 60 * 60_000);
		const [again] = await repo.active(PARTNER_ID, entityId, later);
		expect(again?.seen).toEqual(["https://a.example/1", "https://a.example/2"]);
		expect(again?.due).toBe(true);
	});

	it(`知らせたものは新しい ${WATCH_SEEN_LIMIT} 件だけ覚える`, async () => {
		const { entityId } = await setup("watch-seen-cap");
		const repo = createWatchRepo(drizzle(env.DB));
		const added = await repo.add({
			partnerId: PARTNER_ID,
			entityId,
			query: "q",
			sources: [],
			intervalMinutes: 120,
			untilAt: null,
			now: T0,
		});
		const id = added.ok ? added.value.id : "";
		const keys = Array.from(
			{ length: WATCH_SEEN_LIMIT + 5 },
			(_, i) => `k${i}`,
		);
		await repo.recordCheck({
			partnerId: PARTNER_ID,
			entityId,
			id,
			seen: keys,
			now: T0,
		});
		const [w] = await repo.active(PARTNER_ID, entityId, T0);
		expect(w?.seen).toHaveLength(WATCH_SEEN_LIMIT);
		expect(w?.seen[0]).toBe("k5");
	});

	it(`期限を過ぎた見張りは出さず、動いている見張りは ${ACTIVE_WATCH_LIMIT} 件まで、同じものは重ねない`, async () => {
		const { entityId } = await setup("watch-limit");
		const repo = createWatchRepo(drizzle(env.DB));
		const add = (query: string, untilAt: Date | null = null) =>
			repo.add({
				partnerId: PARTNER_ID,
				entityId,
				query,
				sources: [],
				intervalMinutes: 1440,
				untilAt,
				now: T0,
			});
		expect((await add("期限つき", new Date("2026-11-07T00:00:00Z"))).ok).toBe(
			true,
		);
		expect(
			(
				await repo.active(
					PARTNER_ID,
					entityId,
					new Date("2026-11-08T00:00:00Z"),
				)
			).length,
		).toBe(0);
		expect(await add("期限つき")).toEqual({
			ok: false,
			error: { type: "duplicate" },
		});
		for (let i = 1; i < ACTIVE_WATCH_LIMIT; i++) {
			expect((await add(`見張り${i}`)).ok).toBe(true);
		}
		expect(await add("もう 1 つ")).toEqual({
			ok: false,
			error: { type: "limit" },
		});
	});
});
