import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { StatusResponseSchema } from "@yunomi/admin-contract";
import { PARTNER_IDS } from "@yunomi/core";
import { FakeLLMProvider, ModelRouter } from "@yunomi/llm";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { partnerProfile, partnerProfiles } from "../src/partners.ts";
import { listSnapshots } from "../src/snapshot-store.ts";
import { BOT, llmOk, newScenario, T0, turn } from "./e2e/harness.ts";
import { envelopeBody, inbound, partnerStub } from "./helpers.ts";

const AKARIN = "akarin";

const sendAs = async (partnerId: string, s: ReturnType<typeof newScenario>) => {
	const msg = inbound({
		partnerId,
		channelId: s.channelId,
		author: s.author,
		mentionedUserIds: [BOT],
		content: "あかりん、おはよう",
	});
	const res = await exports.default.fetch(
		new Request("http://localhost/v1/interfaces/discord/events", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-yunomi-dev-caller": "gateway",
			},
			body: JSON.stringify(envelopeBody(msg)),
		}),
	);
	await partnerStub(partnerId).flushBackground();
	return { msg, res };
};

const installFake = async (partnerId: string) => {
	const fake = new FakeLLMProvider([
		llmOk(
			turn({
				messages: ["おはようございます！"],
				relationship_delta: { familiarity: 0.1, trust: 0 },
			}),
		),
	]);
	await runInDurableObject(partnerStub(partnerId), (o) => {
		o.now = () => T0;
		o.createRouter = () => new ModelRouter({ provider: fake });
	});
	return fake;
};

const relationshipCount = (partnerId: string, entityId: string) =>
	runInDurableObject(
		partnerStub(partnerId),
		(_o, s) =>
			s.storage.sql
				.exec<{ n: number }>(
					"SELECT COUNT(*) AS n FROM relationships WHERE entity_id = ?",
					entityId,
				)
				.one().n,
	);

describe("名簿", () => {
	it("名簿の全員にプロファイルがあり、ID が一致する", () => {
		expect(partnerProfiles.map((p) => p.partner_id)).toEqual([...PARTNER_IDS]);
		expect(partnerProfile("nobody")).toBeNull();
	});

	it("DO は自分の名前のパートナーとして振る舞い、名簿にない名前は yukarin になる", async () => {
		const idOf = (name: string) =>
			runInDurableObject(partnerStub(name), (o) => o.profile.partner_id);
		expect(await idOf(AKARIN)).toBe(AKARIN);
		expect(await idOf("yukarin")).toBe("yukarin");
		expect(await idOf("health")).toBe("yukarin");
	});
});

describe("Akarin の会話", () => {
	it("Akarin の人格で返事をし、DO と D1 の行は Akarin のものとして残り、entity は共有する", async () => {
		const s = newScenario();
		const fake = await installFake(AKARIN);
		const { msg, res } = await sendAs(AKARIN, s);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ action: "reply" });

		const system =
			fake.requests
				.at(-1)
				?.system.map((b) => b.text)
				.join("\n") ?? "";
		expect(system).toContain("紲星あかり");
		expect(system).not.toContain("結月ゆかり");

		const audit = await env.DB.prepare(
			"SELECT partner_id FROM audit_events WHERE event_id = ?",
		)
			.bind(msg.eventId)
			.all<{ partner_id: string }>();
		expect(audit.results.map((r) => r.partner_id)).toEqual([AKARIN]);

		const identities = await env.DB.prepare(
			"SELECT entity_id FROM external_identities WHERE provider = 'discord' AND external_id = ?",
		)
			.bind(s.author.id)
			.all<{ entity_id: string }>();
		expect(identities.results).toHaveLength(1);
		const entityId = identities.results[0]?.entity_id ?? "";
		expect(await relationshipCount(AKARIN, entityId)).toBe(1);
		expect(await relationshipCount("yukarin", entityId)).toBe(0);
	});

	it("名簿にない partner は 404", async () => {
		const { res } = await sendAs("nobody", newScenario());
		expect(res.status).toBe(404);
	});
});

describe("Admin API", () => {
	it("Akarin の status を返す", async () => {
		const res = await exports.default.fetch(
			new Request(`http://localhost/admin/api/partners/${AKARIN}/status`, {
				headers: { "x-yunomi-dev-caller": "ykm" },
			}),
		);
		expect(res.status).toBe(200);
		const body = v.parse(StatusResponseSchema, await res.json());
		expect(body.partner_id).toBe(AKARIN);
	});
});

describe("cron", () => {
	it("名簿の全員の Snapshot を作る", async () => {
		await worker.scheduled(
			{ scheduledTime: T0.getTime(), cron: "17 19 * * *", noRetry() {} },
			env,
		);
		for (const id of PARTNER_IDS) {
			const items = await listSnapshots(env.SNAPSHOTS, id);
			expect(
				items.map((i) => i.created_at),
				id,
			).toContain(T0.toISOString());
		}
	});
});
