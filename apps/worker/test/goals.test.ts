import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { PendingStore } from "@yunomi/capabilities";
import { FakeLLMProvider, ModelRouter, type StepRequest } from "@yunomi/llm";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { defaultCapabilities } from "../src/capabilities.ts";
import { createMemoryRepo } from "../src/memory.ts";
import { createGoalStore, OPEN_GOAL_LIMIT } from "../src/work-notes.ts";
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
	return { id: `goal-owner-${seq}`, displayName: "alice", isBot: false };
};

const systemText = (req: StepRequest<unknown> | undefined) =>
	(req?.system ?? []).map((b) => b.text).join("\n");

const block = (req: StepRequest<unknown> | undefined, heading: string) =>
	req?.system.find((b) => b.text.startsWith(heading))?.text ?? "";

/** オーナーを決めた defaultCapabilities を PartnerDO に差し込む。 */
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
					goals: createGoalStore(drizzle(env.DB)),
				},
			) ?? undefined;
	});
	const say = (content: string, author = owner) =>
		stub.handleDiscordMessage(
			inbound({ author, mentionedUserIds: [BOT], content }),
		);
	return { owner, stub, fake, say };
};

const readMemory = async (discordUserId: string) =>
	(await (
		await exports.default.fetch(
			new Request(`${URL_MEMORY}?discord_user_id=${discordUserId}`, {
				headers: working,
			}),
		)
	).json()) as {
		episodes: { predicate: string; object: string }[];
		goals: { id: string; summary: string; created_at: string }[];
	};

const send = (method: "POST" | "PATCH", body: unknown) =>
	exports.default.fetch(
		new Request(URL_MEMORY, {
			method,
			headers: { "content-type": "application/json", ...working },
			body: JSON.stringify(body),
		}),
	);

describe("目標の道具", () => {
	it("オーナーがいて置き場所があれば goal_add と goal_close を持つ", () => {
		const deps = {
			pending: inertStore,
			policy: yukarinProfile.capability_defaults,
			now: () => T0,
			goals: createGoalStore(drizzle(env.DB)),
		};
		expect(
			defaultCapabilities(
				{ OWNER_DISCORD_USER_ID: "u1" },
				deps,
			)?.gate.definitions.map((d) => d.name),
		).toEqual(["goal_add", "goal_close", "pending_confirm", "pending_cancel"]);
		expect(defaultCapabilities({}, deps)).toBeNull();
	});

	it("会話で登録した目標が、次のターンの「オーナーの目標」と Working の記憶に出る", async () => {
		const { owner, fake, say } = await setup("goal-add");
		fake.enqueueStep(
			toolUse([
				{ name: "goal_add", input: { summary: "年内に英語で発表する" } },
			]),
			final("覚えておきますね"),
		);
		const res = await say("年内に英語で発表するのを目標にしたい");
		expect(res.audit.toolCalls[0]).toMatchObject({
			tool: "goal_add",
			decision: "auto",
			outcome: "ok",
		});
		// 道具の結果に目標の文面は残すが、Audit の要約には入れない
		expect(res.audit.toolCalls[0]?.summary).not.toContain("英語");

		const memory = await readMemory(owner.id);
		expect(memory.goals.map((g) => g.summary)).toEqual([
			"年内に英語で発表する",
		]);
		expect(memory.episodes).toEqual([]);

		fake.enqueueStep(final("英語の発表ですね"));
		const asked = fake.stepRequests.length;
		await say("目標なんだっけ");
		const goals = block(fake.stepRequests[asked], "## オーナーの目標");
		expect(goals).toContain(
			`- [${memory.goals[0]?.id}] 年内に英語で発表する（11/6 から）`,
		);
		expect(block(fake.stepRequests[asked], "## 覚えていること")).not.toContain(
			"英語",
		);
	});

	it("会話で達成と言えば goal_close で閉じ、一覧から消える", async () => {
		const { owner, fake, say } = await setup("goal-close");
		const added = await send("POST", {
			discord_user_id: owner.id,
			kind: "goal",
			summary: "毎朝走る",
		});
		// 話したことのない相手には書けない
		expect(added.status).toBe(404);

		fake.enqueueStep(final("こんにちは"));
		await say("こんにちは");
		const created = (await (
			await send("POST", {
				discord_user_id: owner.id,
				kind: "goal",
				summary: "毎朝走る",
			})
		).json()) as { id: string };

		fake.enqueueStep(
			toolUse([
				{ name: "goal_close", input: { id: created.id, status: "dropped" } },
			]),
			final("わかりました"),
		);
		const res = await say("走るのはやめた");
		expect(res.audit.toolCalls[0]).toMatchObject({
			tool: "goal_close",
			outcome: "ok",
		});
		expect((await readMemory(owner.id)).goals).toEqual([]);
		const row = await env.DB.prepare(
			"SELECT status, closed_at FROM work_notes WHERE id = ?",
		)
			.bind(created.id)
			.first();
		expect(row).toEqual({ status: "dropped", closed_at: T0.toISOString() });
	});

	it("オーナー以外のターンには目標のブロックを出さない", async () => {
		const { fake, say } = await setup("goal-other");
		fake.enqueueStep(final("こんにちは"));
		await say("こんにちは", newOwner());
		expect(systemText(fake.stepRequests[0])).not.toContain("## オーナーの目標");
	});
});

describe("Working の記憶の口の目標", () => {
	const talked = async (name: string) => {
		const { owner, fake, say } = await setup(name);
		fake.enqueueStep(final("こんにちは"));
		await say("こんにちは");
		return owner;
	};

	it("足す・重複は 409・閉じる・閉じたものは 404", async () => {
		const owner = await talked("goal-api");
		const add = (summary: string) =>
			send("POST", { discord_user_id: owner.id, kind: "goal", summary });
		const res = await add("  本を 1 冊書く ");
		expect(res.status).toBe(201);
		const goal = (await res.json()) as { id: string; summary: string };
		expect(goal.summary).toBe("本を 1 冊書く");
		expect(await (await add("本を 1 冊書く")).json()).toEqual({
			error: "duplicate_goal",
		});

		const close = (status: string) =>
			send("PATCH", { discord_user_id: owner.id, id: goal.id, status });
		expect((await close("open")).status).toBe(400);
		const closed = await close("achieved");
		expect(closed.status).toBe(200);
		expect(await closed.json()).toEqual({
			id: goal.id,
			summary: "本を 1 冊書く",
			status: "achieved",
		});
		expect((await close("achieved")).status).toBe(404);
		// 閉じたあとは同じ目標をまた足せる
		expect((await add("本を 1 冊書く")).status).toBe(201);
	});

	it(`open な目標は ${OPEN_GOAL_LIMIT} 件まで`, async () => {
		const owner = await talked("goal-limit");
		for (let i = 0; i < OPEN_GOAL_LIMIT; i++) {
			const r = await send("POST", {
				discord_user_id: owner.id,
				kind: "goal",
				summary: `目標${i}`,
			});
			expect(r.status).toBe(201);
		}
		const over = await send("POST", {
			discord_user_id: owner.id,
			kind: "goal",
			summary: "もう 1 つ",
		});
		expect(over.status).toBe(409);
		expect(await over.json()).toEqual({ error: "goal_limit" });
		// 目標は Talking の出来事に混ぜない
		const entity = await env.DB.prepare(
			"SELECT entity_id FROM external_identities WHERE provider = 'discord' AND external_id = ?",
		)
			.bind(owner.id)
			.first<{ entity_id: string }>();
		const facts = await createMemoryRepo(drizzle(env.DB)).topFacts(
			PARTNER_ID,
			entity?.entity_id as string,
		);
		expect(facts).toEqual([]);
	});
});
