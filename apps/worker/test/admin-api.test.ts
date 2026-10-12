import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
	AuditResponseSchema,
	InterestsResponseSchema,
	MemoryResponseSchema,
	OpenLoopsResponseSchema,
	OpinionsResponseSchema,
	RelationshipsResponseSchema,
	StatusResponseSchema,
} from "@yunomi/admin-contract";
import { FakeLLMProvider, HAIKU, ModelRouter } from "@yunomi/llm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import * as v from "valibot";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { turn } from "./e2e/harness.ts";
import { inbound, PARTNER_ID, partnerStub } from "./helpers.ts";

const TEAM = "chanuco.cloudflareaccess.com";
const AUD_DEV =
	"e00c18aa3cabf85ef55c47bd76646b4afa7c763d7cde887085e9a66df1243865";
const GATEWAY_CN = "96068ba533c2ad93dabb8eb2ced3d1c1.access";
const YKM_CN = "c12627e314018b2f83b122b99b4a7ec3.access";
const HOST = "https://yunomi-dev.chanu.co";
const BASE = `/admin/api/partners/${PARTNER_ID}`;

let privateKey: CryptoKey;
let jwks: { keys: unknown[] };

beforeAll(async () => {
	const pair = await generateKeyPair("RS256");
	privateKey = pair.privateKey;
	jwks = {
		keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
	};
});

afterEach(() => vi.restoreAllMocks());

const mockCerts = () => {
	const real = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new Request(input as RequestInfo).url;
		if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
			return Response.json(jwks);
		}
		return real(input, init);
	});
};

const token = (claims: Record<string, unknown>) =>
	new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "k1" })
		.setIssuer(`https://${TEAM}`)
		.setAudience(AUD_DEV)
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(privateKey);

const get = (path: string, headers: Record<string, string> = {}, host = HOST) =>
	exports.default.fetch(new Request(`${host}${path}`, { headers }));

const asYkm = { "x-yunomi-dev-caller": "ykm" };
const local = (path: string, headers: Record<string, string> = asYkm) =>
	get(path, headers, "http://localhost");

const jwtHeader = async (claims: Record<string, unknown>) => {
	mockCerts();
	return { "Cf-Access-Jwt-Assertion": await token(claims) };
};

describe("認可", () => {
	it("owner の JWT で 200", async () => {
		const res = await get(
			`${BASE}/status`,
			await jwtHeader({ email: "teacatus@gmail.com" }),
		);
		expect(res.status).toBe(200);
	});

	it("ykm の service token で 200", async () => {
		const res = await get(
			`${BASE}/status`,
			await jwtHeader({ common_name: YKM_CN }),
		);
		expect(res.status).toBe(200);
	});

	it("open-loops も gateway は 403、JWT なしは 401", async () => {
		expect(
			(
				await get(
					`${BASE}/open-loops`,
					await jwtHeader({ common_name: GATEWAY_CN }),
				)
			).status,
		).toBe(403);
		expect((await get(`${BASE}/open-loops`)).status).toBe(401);
		expect(
			(
				await get(
					`${BASE}/open-loops`,
					await jwtHeader({ common_name: YKM_CN }),
				)
			).status,
		).toBe(200);
	});

	it("interests / opinions も gateway は 403、JWT なしは 401、ykm は 200", async () => {
		for (const path of ["interests", "opinions"]) {
			expect(
				(
					await get(
						`${BASE}/${path}`,
						await jwtHeader({ common_name: GATEWAY_CN }),
					)
				).status,
			).toBe(403);
			expect((await get(`${BASE}/${path}`)).status).toBe(401);
			expect(
				(await get(`${BASE}/${path}`, await jwtHeader({ common_name: YKM_CN })))
					.status,
			).toBe(200);
		}
	});

	it("gateway の service token は 403", async () => {
		const res = await get(
			`${BASE}/status`,
			await jwtHeader({ common_name: GATEWAY_CN }),
		);
		expect(res.status).toBe(403);
	});

	it("owner 以外の email は 403", async () => {
		const res = await get(
			`${BASE}/status`,
			await jwtHeader({ email: "someone@example.com" }),
		);
		expect(res.status).toBe(403);
	});

	it("JWT なしは 401", async () => {
		expect((await get(`${BASE}/status`)).status).toBe(401);
	});

	it("不正な JWT は 401", async () => {
		mockCerts();
		const res = await get(`${BASE}/status`, {
			"Cf-Access-Jwt-Assertion": "not.a.jwt",
		});
		expect(res.status).toBe(401);
	});

	it("localhost の dev bypass は ykm だけ通り、gateway は 403", async () => {
		expect((await local(`${BASE}/status`)).status).toBe(200);
		const res = await local(`${BASE}/status`, {
			"x-yunomi-dev-caller": "gateway",
		});
		expect(res.status).toBe(403);
	});

	it("認証が先で、未知のパスも未認証なら 401", async () => {
		expect((await get("/admin/api/nope")).status).toBe(401);
		expect((await local("/admin/api/nope")).status).toBe(404);
	});

	it("書き込み系メソッドは 405", async () => {
		const res = await exports.default.fetch(
			new Request(`http://localhost${BASE}/status`, {
				method: "POST",
				headers: asYkm,
			}),
		);
		expect(res.status).toBe(405);
	});

	it("未知の partner は 404", async () => {
		const res = await local("/admin/api/partners/other/status");
		expect(res.status).toBe(404);
	});
});

const parse = async <T extends v.GenericSchema>(res: Response, schema: T) => {
	expect(res.status).toBe(200);
	const body = await res.json();
	const r = v.safeParse(schema, body);
	expect(r.success, JSON.stringify(r.issues)).toBe(true);
	return body as v.InferOutput<T>;
};

describe("status / relationships", () => {
	it("ターン処理前は state が null で、処理後は現在値を返す", async () => {
		const before = await parse(
			await local(`${BASE}/status`),
			StatusResponseSchema,
		);
		expect(before).toMatchObject({
			partner_id: PARTNER_ID,
			env: "development",
			state: null,
		});

		const stub = partnerStub(PARTNER_ID);
		const fake = new FakeLLMProvider([
			{
				ok: true,
				value: {
					output: turn({
						emotion_delta: { mood: 0.1, energy: 0 },
						relationship_delta: { familiarity: 0.02, trust: 0 },
					}),
					model: HAIKU,
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
					latencyMs: 1,
					stopReason: "end_turn",
				},
			},
		]);
		await runInDurableObject(stub, (o) => {
			o.createRouter = () => new ModelRouter({ provider: fake });
		});
		await stub.handleDiscordMessage(
			inbound({
				mentionedUserIds: [env.PARTNER_DISCORD_USER_ID],
				author: { id: "admin-u1", displayName: "alice", isBot: false },
			}),
		);
		await stub.flushBackground();

		const after = await parse(
			await local(`${BASE}/status`),
			StatusResponseSchema,
		);
		expect(after.state?.mood).toBeCloseTo(0.3);
		expect(after.last_audit_at).not.toBeNull();

		const rels = await parse(
			await local(`${BASE}/relationships`),
			RelationshipsResponseSchema,
		);
		expect(rels.items).toHaveLength(1);
		expect(rels.items[0]).toMatchObject({ display_name: "alice" });
		expect(rels.items[0]?.familiarity).toBeCloseTo(0.12);
	});
});

const insertAudit = (id: string, createdAt: string) =>
	env.DB.prepare(
		`INSERT INTO audit_events (id, partner_id, event_id, dedupe_key, channel_id, author_entity_id, kind, decision, reason, decision_summary, model, fallback_used, degraded, error_type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms, inbound_content, detail_json, occurred_at, created_at)
		VALUES (?1, ?2, ?1, ?1, 'c', NULL, 'turn', 'ignore', 'bot', NULL, NULL, 0, 0, NULL, 0, 0, 0, 0, 0, 'x', '{}', ?3, ?3)`,
	)
		.bind(id, PARTNER_ID, createdAt)
		.run();

describe("audit", () => {
	it("新しい順に cursor でたどれ、同時刻の行も欠落・重複しない", async () => {
		const rows: [string, string][] = [
			["a1", "2031-01-01T00:00:01.000Z"],
			["a2", "2031-01-01T00:00:02.000Z"],
			["a3", "2031-01-01T00:00:02.000Z"],
			["a4", "2031-01-01T00:00:03.000Z"],
			["a5", "2031-01-01T00:00:04.000Z"],
		];
		for (const [id, at] of rows) await insertAudit(id, at);

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const q: string = `limit=2&since=2031-01-01T00:00:00Z${cursor ? `&cursor=${cursor}` : ""}`;
			const page = await parse(
				await local(`${BASE}/audit?${q}`),
				AuditResponseSchema,
			);
			seen.push(...page.items.map((i) => i.id));
			cursor = page.next_cursor;
			pages++;
		} while (cursor);

		expect(seen).toEqual(["a5", "a4", "a3", "a2", "a1"]);
		expect(pages).toBe(3);
	});

	it("since より古い行は返さない", async () => {
		await insertAudit("s1", "2032-01-01T00:00:00.000Z");
		await insertAudit("s2", "2032-01-02T00:00:00.000Z");
		const page = await parse(
			await local(`${BASE}/audit?since=2032-01-02T00:00:00Z`),
			AuditResponseSchema,
		);
		expect(page.items.map((i) => i.id)).toEqual(["s2"]);
	});

	it("不正な limit / cursor / since は 400", async () => {
		for (const q of [
			"limit=0",
			"limit=1000",
			"limit=abc",
			"cursor=!!!",
			"since=yesterday",
		]) {
			expect((await local(`${BASE}/audit?${q}`)).status, q).toBe(400);
		}
	});
});

describe("memory", () => {
	it("facts と candidates を kind で切り替えて返す", async () => {
		await env.DB.prepare(
			"INSERT INTO entities (id, kind, display_name, created_at) VALUES ('adm-e1', 'person', 'bob', '2031-01-01T00:00:00Z')",
		).run();
		await env.DB.prepare(
			`INSERT INTO facts (id, partner_id, subject_entity_id, predicate, object_type, object_value, confidence, importance, source, observed_at, valid_from)
			VALUES ('f1', ?1, 'adm-e1', '好きな飲み物', 'string', '緑茶', 0.9, 0.7, 'user_statement', '2031-02-01T00:00:00Z', '2031-02-01T00:00:00Z'),
			('f2', ?1, 'adm-e1', '趣味', 'string', '散歩', 0.9, 0.7, 'user_statement', '2031-02-02T00:00:00Z', '2031-02-02T00:00:00Z')`,
		)
			.bind(PARTNER_ID)
			.run();
		await env.DB.prepare(
			`INSERT INTO memory_candidates (id, partner_id, subject_entity_id, subject_text, predicate, object_type, object_value, confidence, importance, source, status, conflict_fact_id, expires_at, created_at, source_event_id)
			VALUES ('c1', ?1, NULL, '友達', '誕生日', 'string', '5月', 0.5, 0.5, 'inferred', 'pending', NULL, '2031-03-01T00:00:00Z', '2031-02-01T00:00:00Z', 'ev')`,
		)
			.bind(PARTNER_ID)
			.run();

		const first = await parse(
			await local(`${BASE}/memory?kind=facts&limit=1`),
			MemoryResponseSchema,
		);
		expect(first.kind).toBe("facts");
		expect(first.items.map((i) => i.id)).toEqual(["f2"]);
		expect(first.next_cursor).not.toBeNull();

		const second = await parse(
			await local(
				`${BASE}/memory?kind=facts&limit=1&cursor=${first.next_cursor}`,
			),
			MemoryResponseSchema,
		);
		expect(second.items.map((i) => i.id)).toEqual(["f1"]);
		expect(second.next_cursor).toBeNull();

		const cands = await parse(
			await local(`${BASE}/memory?kind=candidates`),
			MemoryResponseSchema,
		);
		expect(cands.kind).toBe("candidates");
		expect(cands.items.map((i) => i.id)).toContain("c1");

		const status = await parse(
			await local(`${BASE}/status`),
			StatusResponseSchema,
		);
		expect(status.counts.facts).toBeGreaterThanOrEqual(2);
		expect(status.counts.pending_candidates).toBeGreaterThanOrEqual(1);
	});

	it("Fact は既定で置き換え済み・期限切れを除き、include=all で全件返す", async () => {
		const p = PARTNER_ID;
		await env.DB.prepare(
			"INSERT INTO entities (id, kind, display_name, created_at) VALUES ('adm-e2', 'person', 'carol', '2031-01-01T00:00:00Z')",
		).run();
		const fact = (
			id: string,
			validTo: string | null,
			supersededBy: string | null,
		) =>
			env.DB.prepare(
				`INSERT INTO facts (id, partner_id, subject_entity_id, predicate, object_type, object_value, confidence, importance, source, observed_at, valid_from, valid_to, superseded_by)
				VALUES (?1, ?2, 'adm-e2', ?1, 'string', 'v', 0.9, 0.7, 'user_statement', '2031-02-01T00:00:00Z', '2031-02-01T00:00:00Z', ?3, ?4)`,
			)
				.bind(id, p, validTo, supersededBy)
				.run();
		await fact("cur", null, null);
		await fact("future", "2999-01-01T00:00:00Z", null);
		await fact("expired", "2020-01-01T00:00:00Z", null);
		await fact("old", null, "cur");

		const ids = async (q: string) => {
			const r = await parse(
				await local(`${BASE}/memory?kind=facts&limit=200${q}`),
				MemoryResponseSchema,
			);
			return r.items
				.map((i) => i.id)
				.filter((id) => ["cur", "future", "expired", "old"].includes(id));
		};
		expect((await ids("")).sort()).toEqual(["cur", "future"]);
		expect((await ids("&include=all")).sort()).toEqual([
			"cur",
			"expired",
			"future",
			"old",
		]);
		expect((await local(`${BASE}/memory?include=x`)).status).toBe(400);
	});

	it("不明な kind は 400", async () => {
		expect((await local(`${BASE}/memory?kind=x`)).status).toBe(400);
	});
});

describe("open-loops", () => {
	const seed = async () => {
		await env.DB.prepare(
			"INSERT OR IGNORE INTO entities (id, kind, display_name, created_at) VALUES ('adm-ol-e', 'person', 'dave', '2032-01-01T00:00:00Z')",
		).run();
		await env.DB.prepare(
			`INSERT OR IGNORE INTO open_loops (id, partner_id, entity_id, channel_id, summary, importance, due_at, due_confidence, status, source_message_id, created_at, updated_at, resolved_at)
			VALUES ('ol1', ?1, 'adm-ol-e', 'c1', '面接の結果', 0.7, '2032-02-02T00:00:00Z', 0.5, 'open', 'm1', '2032-02-01T00:00:00Z', '2032-02-01T00:00:00Z', NULL),
			('ol2', ?1, 'adm-ol-e', 'c1', '引っ越しの手続き', 0.4, NULL, NULL, 'resolved', 'm2', '2032-02-02T00:00:00Z', '2032-02-03T00:00:00Z', '2032-02-03T00:00:00Z'),
			('ol3', ?1, 'adm-ol-e', 'c1', '気が変わった件', 0.2, NULL, NULL, 'dropped', 'm3', '2032-02-03T00:00:00Z', '2032-02-03T00:00:00Z', NULL)`,
		)
			.bind(PARTNER_ID)
			.run();
	};
	const ids = (r: { items: { id: string }[] }) =>
		r.items.map((i) => i.id).filter((id) => /^ol\d$/.test(id));

	it("既定は open だけ。status=all で全件を新しい順に返す", async () => {
		await seed();
		const open = await parse(
			await local(`${BASE}/open-loops`),
			OpenLoopsResponseSchema,
		);
		expect(ids(open)).toEqual(["ol1"]);
		expect(open.items.find((i) => i.id === "ol1")).toEqual({
			id: "ol1",
			entity_id: "adm-ol-e",
			entity_display_name: "dave",
			channel_id: "c1",
			summary: "面接の結果",
			importance: 0.7,
			due_at: "2032-02-02T00:00:00Z",
			due_confidence: 0.5,
			follow_up_interval_hours: null,
			status: "open",
			source_message_id: "m1",
			created_at: "2032-02-01T00:00:00Z",
			updated_at: "2032-02-01T00:00:00Z",
			resolved_at: null,
			last_followed_up_at: null,
		});

		const all = await parse(
			await local(`${BASE}/open-loops?status=all`),
			OpenLoopsResponseSchema,
		);
		expect(ids(all)).toEqual(["ol3", "ol2", "ol1"]);
	});

	it("limit と cursor でたどれる", async () => {
		await seed();
		const first = await parse(
			await local(`${BASE}/open-loops?status=all&limit=1`),
			OpenLoopsResponseSchema,
		);
		expect(first.items).toHaveLength(1);
		expect(first.next_cursor).not.toBeNull();
		const second = await parse(
			await local(
				`${BASE}/open-loops?status=all&limit=1&cursor=${first.next_cursor}`,
			),
			OpenLoopsResponseSchema,
		);
		expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
	});

	it("不正な status / limit は 400", async () => {
		expect((await local(`${BASE}/open-loops?status=x`)).status).toBe(400);
		expect((await local(`${BASE}/open-loops?limit=0`)).status).toBe(400);
	});
});

describe("interests / opinions", () => {
	const reset = async () => {
		for (const t of [
			"interest_states",
			"opinion_states",
			"interest_changes",
			"opinion_changes",
		]) {
			await env.DB.prepare(`DELETE FROM ${t}`).run();
		}
	};

	it("行が無いときはプロファイルの初期値を source: profile で返す", async () => {
		await reset();
		const interests = await parse(
			await local(`${BASE}/interests`),
			InterestsResponseSchema,
		);
		expect(interests.items.length).toBeGreaterThanOrEqual(5);
		expect(interests.items[0]).toEqual({
			topic: "games",
			label: "ゲーム",
			score: 0.7,
			baseline: 0.7,
			learned_delta: 0,
			summary: "自分で遊ぶのも、人が遊んでいる話を聞くのも好き。",
			updated_at: null,
			source: "profile",
		});
		expect(interests.items.every((i) => i.source === "profile")).toBe(true);
		const scores = interests.items.map((i) => i.score);
		expect(scores).toEqual([...scores].sort((a, b) => b - a));

		const opinions = await parse(
			await local(`${BASE}/opinions`),
			OpinionsResponseSchema,
		);
		expect(opinions.items.length).toBeGreaterThanOrEqual(3);
		expect(opinions.items[0]).toMatchObject({
			topic: "spoilers",
			confidence: 0.7,
			stability: 0.6,
			reasons: [],
			source_memory_ids: [],
			updated_at: null,
			source: "profile",
		});
	});

	it("学習済みの行は値を上書きし、source: learned で返す", async () => {
		await reset();
		await env.DB.prepare(
			`INSERT INTO interest_states (partner_id, topic, score, baseline, learned_delta, summary, updated_at, source)
			VALUES (?1, 'odd-happenings', 0.56, 0.5, 0.06, '妙な出来事やおかしな言い分には、つい反応してしまう。', '2026-10-11T03:00:00.000Z', 'learned')`,
		)
			.bind(PARTNER_ID)
			.run();
		await env.DB.prepare(
			`INSERT INTO opinion_states (partner_id, topic, stance, confidence, stability, reasons, source_memory_ids, updated_at)
			VALUES (?1, 'tsukkomi', 'おかしな発言でも、まずは最後まで聞いたほうがよい。', 0.4, 0.5, '["話を遮って気まずくなった"]', '[]', '2026-10-11T03:00:00.000Z')`,
		)
			.bind(PARTNER_ID)
			.run();

		const interests = await parse(
			await local(`${BASE}/interests`),
			InterestsResponseSchema,
		);
		const odd = interests.items.find((i) => i.topic === "odd-happenings");
		expect(odd).toMatchObject({
			score: 0.56,
			baseline: 0.5,
			learned_delta: 0.06,
			updated_at: "2026-10-11T03:00:00.000Z",
			source: "learned",
		});
		expect(interests.items.map((i) => i.topic).slice(0, 3)).toEqual([
			"games",
			"game-streaming",
			"odd-happenings",
		]);

		const opinions = await parse(
			await local(`${BASE}/opinions`),
			OpinionsResponseSchema,
		);
		expect(opinions.items.find((o) => o.topic === "tsukkomi")).toMatchObject({
			stance: "おかしな発言でも、まずは最後まで聞いたほうがよい。",
			confidence: 0.4,
			reasons: ["話を遮って気まずくなった"],
			source: "learned",
		});
		expect(opinions.items.find((o) => o.topic === "spoilers")?.source).toBe(
			"profile",
		);
		await reset();
	});

	it("GET 以外は 405", async () => {
		const res = await exports.default.fetch(
			new Request(`http://localhost${BASE}/interests`, {
				method: "POST",
				headers: asYkm,
			}),
		);
		expect(res.status).toBe(405);
	});
});
