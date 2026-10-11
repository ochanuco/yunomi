import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
	SNAPSHOT_SCHEMA_VERSION,
	type Snapshot,
	SnapshotRestoreResponseSchema,
	SnapshotSchema,
	SnapshotsResponseSchema,
} from "@yunomi/admin-contract";
import { Decrypter } from "age-encryption";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGE_RECIPIENT_PATTERN, resources } from "../resources.ts";
import worker from "../src/index.ts";
import { buildSnapshot, D1_SNAPSHOT_TABLES } from "../src/snapshot.ts";
import { encryptSnapshot, parseSnapshot } from "../src/snapshot-codec.ts";
import {
	listSnapshots,
	purgeExpiredSnapshots,
	putSnapshot,
	SNAPSHOT_RETENTION_DAYS,
	snapshotKey,
} from "../src/snapshot-store.ts";
import { PARTNER_ID, partnerStub } from "./helpers.ts";
import { TEST_AGE_IDENTITY, TEST_AGE_RECIPIENT } from "./snapshot-keys.ts";

const NOW = new Date("2026-10-11T03:00:00Z");
const BASE = `http://localhost/admin/api/partners/${PARTNER_ID}`;
const ykm = { "x-yunomi-dev-caller": "ykm" };
const gateway = { "x-yunomi-dev-caller": "gateway" };

afterEach(() => vi.restoreAllMocks());

// テスト間で D1・DO・R2 の状態が残るため、毎回空にする。
beforeEach(async () => {
	for (const t of [
		"facts",
		"memory_candidates",
		"open_loops",
		"interest_states",
		"opinion_states",
		"interest_changes",
		"audit_events",
		"audit_daily_kpis",
		"external_identities",
		"entities",
	]) {
		await env.DB.prepare(`DELETE FROM ${t}`).run();
	}
	await runInDurableObject(partnerStub(), (_o, state) => {
		for (const t of [
			"partner_state",
			"relationships",
			"recent_messages",
			"entity_cache",
		]) {
			state.storage.sql.exec(`DELETE FROM ${t}`);
		}
	});
	const { objects } = await env.SNAPSHOTS.list();
	if (objects.length > 0) {
		await env.SNAPSHOTS.delete(objects.map((o) => o.key));
	}
});

const run = (sql: string, ...params: unknown[]) =>
	env.DB.prepare(sql)
		.bind(...params)
		.run();

const seedD1 = async (partner = PARTNER_ID) => {
	await run(
		"INSERT OR REPLACE INTO entities (id, kind, display_name, created_at) VALUES ('e1', 'person', 'alice', '2026-10-01T00:00:00Z')",
	);
	await run(
		"INSERT OR REPLACE INTO external_identities (provider, external_id, entity_id) VALUES ('discord', 'u1', 'e1')",
	);
	await run(
		`INSERT INTO facts (id, partner_id, subject_entity_id, predicate, object_type, object_value, object_display, confidence, importance, source, observed_at, valid_from, valid_to, decay_policy, superseded_by)
		VALUES ('f1', ?, 'e1', 'likes', 'text', 'tea', NULL, 0.9, 0.8, 'conversation', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z', NULL, 'standard', NULL)`,
		partner,
	);
	await run(
		`INSERT INTO memory_candidates (id, partner_id, subject_entity_id, subject_text, predicate, object_type, object_value, confidence, importance, source, status, conflict_fact_id, expires_at, created_at, source_event_id)
		VALUES ('c1', ?, 'e1', NULL, 'plays', 'text', 'go', 0.5, 0.5, 'conversation', 'pending', NULL, '2026-11-01T00:00:00Z', '2026-10-03T00:00:00Z', 'ev1')`,
		partner,
	);
	await run(
		`INSERT INTO open_loops (id, partner_id, entity_id, channel_id, summary, importance, due_at, due_confidence, follow_up_interval_hours, status, source_message_id, created_at, updated_at, resolved_at, last_followed_up_at)
		VALUES ('o1', ?, 'e1', 'c1', '面接の結果待ち', 0.7, NULL, NULL, NULL, 'open', 'm1', '2026-10-04T00:00:00Z', '2026-10-04T00:00:00Z', NULL, NULL)`,
		partner,
	);
	await run(
		`INSERT INTO interest_states (partner_id, topic, score, baseline, learned_delta, summary, updated_at, source)
		VALUES (?, 'tea', 0.6, 0.5, 0.1, 's', '2026-10-05T00:00:00Z', 'learned')`,
		partner,
	);
	await run(
		`INSERT INTO opinion_states (partner_id, topic, stance, confidence, stability, reasons, source_memory_ids, updated_at)
		VALUES (?, 'tea', 'good', 0.6, 0.5, '[]', '[]', '2026-10-05T00:00:00Z')`,
		partner,
	);
};

/** 履歴・audit・KPI。Snapshot に入らず、restore でも変わらないことを確かめる。 */
const seedExcluded = async () => {
	await run(
		`INSERT INTO audit_events (id, partner_id, event_id, dedupe_key, channel_id, author_entity_id, kind, decision, reason, decision_summary, model, fallback_used, degraded, error_type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms, inbound_content, detail_json, occurred_at, created_at)
		VALUES ('a1', ?, 'a1', 'a1', 'c', NULL, 'turn', 'reply', 'r', NULL, NULL, 0, 0, NULL, 0, 0, 0, 0, 0, '会話の本文', '{}', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')`,
		PARTNER_ID,
	);
	await run(
		`INSERT INTO audit_daily_kpis (partner_id, day, turns, replies, ignores, errors, degraded, fallback_used, latency_p50_ms, latency_p95_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, updated_at)
		VALUES (?, '2026-10-09', 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, '2026-10-10T00:00:00Z')`,
		PARTNER_ID,
	);
	await run(
		`INSERT INTO interest_changes (id, partner_id, topic, before_score, after_score, reason, source_message_id, lifestyle_day, created_at)
		VALUES ('ic1', ?, 'tea', 0.5, 0.6, 'r', 'm1', '2026-10-05', '2026-10-05T00:00:00Z')`,
		PARTNER_ID,
	);
};

const seedDo = async () => {
	await runInDurableObject(partnerStub(), (_o, state) => {
		const sql = state.storage.sql;
		sql.exec("DELETE FROM partner_state");
		sql.exec("DELETE FROM relationships");
		sql.exec(
			"INSERT INTO partner_state (id, mood, energy, presence, system_stress, degraded_mode, version, updated_at) VALUES (1, 0.3, 0.5, 'available', 0.1, 0, 4, '2026-10-10T00:00:00Z')",
		);
		sql.exec(
			"INSERT INTO relationships (entity_id, familiarity, trust, summary, version, updated_at, acc_day, acc_familiarity, acc_trust) VALUES ('e1', 0.4, 0.3, NULL, 2, '2026-10-10T00:00:00Z', '2026-10-10', 0.01, 0.02)",
		);
		sql.exec(
			"INSERT INTO recent_messages (channel_id, message_id, author_id, author_name, is_bot, is_partner, content, occurred_at) VALUES ('c1', 'm1', 'u1', 'alice', 0, 0, 'ひみつの発言', '2026-10-10T00:00:00Z')",
		);
	});
};

const build = async (): Promise<Snapshot> => {
	const r = await buildSnapshot({
		db: env.DB,
		partner: partnerStub(),
		partnerId: PARTNER_ID,
		env: "development",
		now: NOW,
	});
	if (!r.ok) throw new Error(r.error.message);
	return r.value;
};

const decrypt = async (bytes: Uint8Array): Promise<unknown> => {
	const d = new Decrypter();
	d.addIdentity(TEST_AGE_IDENTITY);
	const gz = await d.decrypt(bytes);
	const json = await new Response(
		new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip")),
	).text();
	return JSON.parse(json);
};

const count = async (table: string) =>
	(
		await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
			n: number;
		}>()
	)?.n;

describe("Snapshot の組み立て", () => {
	it("長期記憶と DO の現在値を含み、会話本文・audit・履歴は含めない", async () => {
		await seedD1();
		await seedExcluded();
		await seedDo();
		const s = await build();

		expect(v.safeParse(SnapshotSchema, s).success).toBe(true);
		expect(s.schema_version).toBe(SNAPSHOT_SCHEMA_VERSION);
		expect(s.partner_id).toBe(PARTNER_ID);
		expect(s.env).toBe("development");
		expect(s.created_at).toBe(NOW.toISOString());
		expect(s.d1.entities.map((e) => e.id)).toEqual(["e1"]);
		expect(s.d1.facts[0]?.object_value).toBe("tea");
		expect(s.d1.open_loops[0]?.summary).toBe("面接の結果待ち");
		expect(s.d1.interest_states).toHaveLength(1);
		expect(s.d1.opinion_states).toHaveLength(1);
		expect(s.do.state?.version).toBe(4);
		expect(s.do.relationships[0]).toMatchObject({
			entity_id: "e1",
			acc_day: "2026-10-10",
		});

		expect(Object.keys(s.d1).sort()).toEqual(
			Object.keys(D1_SNAPSHOT_TABLES).sort(),
		);
		const text = JSON.stringify(s);
		for (const leaked of ["会話の本文", "ひみつの発言", "ic1", "audit"]) {
			expect(text).not.toContain(leaked);
		}
	});

	it("他の partner の行は含めない", async () => {
		await seedD1("other");
		const s = await build();
		expect(s.d1.facts).toEqual([]);
	});

	it("列の定義が D1 のスキーマと一致する", async () => {
		for (const [table, def] of Object.entries(D1_SNAPSHOT_TABLES)) {
			const { results } = await env.DB.prepare(
				`PRAGMA table_info(${table})`,
			).all<{ name: string }>();
			const actual = results
				.map((c) => c.name)
				.filter((c) => c !== "partner_id");
			expect(actual.sort(), table).toEqual([...def.columns].sort());
		}
	});

	it("Valibot は未知の列と schema_version の不一致を拒否する", async () => {
		await seedD1();
		const s = await build();
		expect(parseSnapshot({ ...s, schema_version: 2 }).ok).toBe(false);
		expect(
			parseSnapshot({
				...s,
				d1: { ...s.d1, facts: [{ ...s.d1.facts[0], extra: 1 }] },
			}).ok,
		).toBe(false);
	});
});

describe("gzip + age", () => {
	it("テスト鍵で復号すると元の Snapshot に戻り、平文は含まれない", async () => {
		await seedD1();
		const s = await build();
		const bytes = await encryptSnapshot(s, TEST_AGE_RECIPIENT);
		expect(new TextDecoder().decode(bytes)).not.toContain("tea");
		expect(await decrypt(bytes)).toEqual(s);
	});
});

describe("R2 への保存と削除", () => {
	it("キーと customMetadata、30 日より古いものだけ削除", async () => {
		const put = (id: string, createdAt: string) =>
			putSnapshot(env.SNAPSHOTS, {
				id,
				partnerId: PARTNER_ID,
				createdAt,
				env: "development",
				bytes: new Uint8Array([1, 2, 3]),
			});
		const day = 24 * 60 * 60 * 1000;
		await put(
			"00000000-0000-7000-8000-000000000001",
			new Date(
				NOW.getTime() - (SNAPSHOT_RETENTION_DAYS + 1) * day,
			).toISOString(),
		);
		await put(
			"00000000-0000-7000-8000-000000000002",
			new Date(
				NOW.getTime() - (SNAPSHOT_RETENTION_DAYS - 1) * day,
			).toISOString(),
		);
		await put("00000000-0000-7000-8000-000000000003", NOW.toISOString());

		const head = await env.SNAPSHOTS.head(
			snapshotKey(PARTNER_ID, "00000000-0000-7000-8000-000000000003"),
		);
		expect(head?.key).toBe(
			`snapshots/${PARTNER_ID}/00000000-0000-7000-8000-000000000003.json.gz.age`,
		);
		expect(head?.customMetadata).toEqual({
			schema_version: String(SNAPSHOT_SCHEMA_VERSION),
			created_at: NOW.toISOString(),
			env: "development",
		});

		expect(await purgeExpiredSnapshots(env.SNAPSHOTS, PARTNER_ID, NOW)).toBe(1);
		const left = await listSnapshots(env.SNAPSHOTS, PARTNER_ID);
		expect(left.map((s) => s.id)).toEqual([
			"00000000-0000-7000-8000-000000000003",
			"00000000-0000-7000-8000-000000000002",
		]);
		expect(left[0]).toMatchObject({ size: 3, schema_version: 1 });
	});
});

const call = (
	path: string,
	init: RequestInit & { headers?: Record<string, string> } = {},
) =>
	exports.default.fetch(
		new Request(`${BASE}${path}`, { headers: ykm, ...init }),
	);

describe("Admin API", () => {
	it("作成 → 一覧 → 取得で、暗号化された blob をそのまま返す", async () => {
		await seedD1();
		const created = await call("/snapshots", { method: "POST" });
		expect(created.status).toBe(201);
		const summary = (await created.json()) as { id: string; size: number };

		const list = await call("/snapshots");
		const parsed = v.parse(SnapshotsResponseSchema, await list.json());
		expect(parsed.items).toHaveLength(1);
		expect(parsed.items[0]).toMatchObject({
			id: summary.id,
			size: summary.size,
			schema_version: 1,
			env: "development",
		});

		const blob = await call(`/snapshots/${summary.id}`);
		expect(blob.headers.get("content-type")).toBe("application/octet-stream");
		const bytes = new Uint8Array(await blob.arrayBuffer());
		expect(bytes.byteLength).toBe(summary.size);
		const s = (await decrypt(bytes)) as Snapshot;
		expect(s.snapshot_id).toBe(summary.id);
		expect(s.d1.facts).toHaveLength(1);
	});

	it("存在しない id は 404、不正な id も 404", async () => {
		const missing = await call(
			"/snapshots/00000000-0000-7000-8000-0000000000ff",
		);
		expect(missing.status).toBe(404);
		expect((await call("/snapshots/..%2Fx")).status).toBe(404);
	});

	it("認証なしは 401、gateway は 403", async () => {
		const none = await call("/snapshots", { headers: {} });
		expect(none.status).toBe(401);
		const gw = await call("/snapshots", { headers: gateway });
		expect(gw.status).toBe(403);
		const gwPost = await call("/snapshots", {
			method: "POST",
			headers: gateway,
		});
		expect(gwPost.status).toBe(403);
		const gwRestore = await call("/snapshots/restore", {
			method: "POST",
			headers: gateway,
			body: "{}",
		});
		expect(gwRestore.status).toBe(403);
	});

	it("未知の partner は 404", async () => {
		const res = await exports.default.fetch(
			new Request("http://localhost/admin/api/partners/nobody/snapshots", {
				headers: ykm,
			}),
		);
		expect(res.status).toBe(404);
	});
});

const restoreRequest = (body: unknown) =>
	call("/snapshots/restore", {
		method: "POST",
		body: JSON.stringify(body),
	});

describe("restore", () => {
	it("D1 と DO を Snapshot の内容で置き換え、audit・KPI・履歴は触らない", async () => {
		await seedD1();
		await seedDo();
		await seedExcluded();
		const source = await build();

		// restore 先の現在値を、Snapshot と食い違う内容にしておく
		await run("DELETE FROM facts");
		await run(
			`INSERT INTO facts (id, partner_id, subject_entity_id, predicate, object_type, object_value, object_display, confidence, importance, source, observed_at, valid_from, valid_to, decay_policy, superseded_by)
			VALUES ('f-old', ?, 'e1', 'dislikes', 'text', 'coffee', NULL, 0.9, 0.8, 'conversation', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z', NULL, 'standard', NULL)`,
			PARTNER_ID,
		);
		await run("DELETE FROM open_loops");
		await run("UPDATE interest_states SET score = 0.01");
		await runInDurableObject(partnerStub(), (_o, state) => {
			state.storage.sql.exec(
				"UPDATE partner_state SET mood = -0.9, version = 99",
			);
			state.storage.sql.exec("DELETE FROM relationships");
			state.storage.sql.exec(
				"INSERT INTO entity_cache (provider, external_id, entity_id) VALUES ('discord', 'u9', 'gone')",
			);
		});
		const auditBefore = await env.DB.prepare(
			"SELECT * FROM audit_events",
		).all();
		const kpiBefore = await env.DB.prepare(
			"SELECT * FROM audit_daily_kpis",
		).all();
		const historyBefore = await count("interest_changes");

		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const res = await restoreRequest(source);
		expect(res.status).toBe(200);
		const body = v.parse(SnapshotRestoreResponseSchema, await res.json());
		expect(body).toMatchObject({
			snapshot_id: source.snapshot_id,
			source_env: "development",
			counts: { facts: 1, open_loops: 1, relationships: 1, entities: 1 },
		});
		// Discord や外部サービスへ何も送らない
		expect(fetchSpy).not.toHaveBeenCalled();

		expect((await build()).d1).toEqual(source.d1);
		const after = await build();
		expect(after.do).toEqual(source.do);
		await runInDurableObject(partnerStub(), (_o, state) => {
			expect(
				state.storage.sql.exec("SELECT COUNT(*) AS n FROM entity_cache").one()
					.n,
			).toBe(0);
			// 会話本文は Snapshot の対象外なので残る
			expect(
				state.storage.sql
					.exec("SELECT COUNT(*) AS n FROM recent_messages")
					.one().n,
			).toBe(1);
		});

		expect(
			(await env.DB.prepare("SELECT * FROM audit_events").all()).results,
		).toEqual(auditBefore.results);
		expect(
			(await env.DB.prepare("SELECT * FROM audit_daily_kpis").all()).results,
		).toEqual(kpiBefore.results);
		expect(await count("interest_changes")).toBe(historyBefore);
	});

	it("restore を 1 行のログに残す", async () => {
		await seedD1();
		const source = await build();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await restoreRequest(source);
		const line = log.mock.calls
			.map((c) => String(c[0]))
			.find((l) => l.includes("snapshot_restore"));
		expect(JSON.parse(line ?? "{}")).toMatchObject({
			event: "snapshot_restore",
			snapshot_id: source.snapshot_id,
			source_env: "development",
			counts: { facts: 1 },
		});
	});

	it("production では 403 restore_disabled_in_production で何も変えない", async () => {
		await seedD1();
		const source = await build();
		await run("DELETE FROM facts");
		const res = await worker.fetch(
			new Request(`${BASE}/snapshots/restore`, {
				method: "POST",
				headers: ykm,
				body: JSON.stringify(source),
			}),
			{ ...env, YUNOMI_ENV: "production" },
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "restore_disabled_in_production",
		});
		expect(await count("facts")).toBe(0);
	});

	it("不正な body は 400、別 partner の Snapshot は 422", async () => {
		expect((await restoreRequest({ nope: 1 })).status).toBe(400);
		const source = await build();
		const res = await restoreRequest({ ...source, partner_id: "other" });
		expect(res.status).toBe(422);
	});

	it("参照先の無い行が混ざったら D1 を変えずに失敗する", async () => {
		await seedD1();
		const source = await build();
		const broken: Snapshot = {
			...source,
			d1: {
				...source.d1,
				external_identities: [
					{ provider: "discord", external_id: "u2", entity_id: "missing" },
				],
			},
		};
		const res = await restoreRequest(broken);
		expect(res.status).toBe(422);
		expect(await count("facts")).toBe(1);
	});
});

describe("cron", () => {
	const cron = (over: Partial<Env>) =>
		worker.scheduled(
			{ scheduledTime: NOW.getTime(), cron: "17 19 * * *", noRetry() {} },
			{ ...env, ...over },
		);

	it("Snapshot を作成し、古いものを削除する", async () => {
		await putSnapshot(env.SNAPSHOTS, {
			id: "00000000-0000-7000-8000-000000000009",
			partnerId: PARTNER_ID,
			createdAt: "2026-01-01T00:00:00.000Z",
			env: "development",
			bytes: new Uint8Array([1]),
		});
		await cron({});
		const items = await listSnapshots(env.SNAPSHOTS, PARTNER_ID);
		expect(items).toHaveLength(1);
		expect(items[0]?.created_at).toBe(NOW.toISOString());
	});

	it("Snapshot が失敗しても KPI 集計と audit 削除は走る", async () => {
		const at = "2026-10-09T21:00:00.000Z";
		const old = "2026-08-01T00:00:00.000Z";
		for (const [id, created] of [
			["k1", at],
			["old", old],
		] as const) {
			await run(
				`INSERT INTO audit_events (id, partner_id, event_id, dedupe_key, channel_id, author_entity_id, kind, decision, reason, decision_summary, model, fallback_used, degraded, error_type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms, inbound_content, detail_json, occurred_at, created_at)
				VALUES (?1, ?2, ?1, ?1, 'c', NULL, 'turn', 'reply', 'r', NULL, NULL, 0, 0, NULL, 0, 0, 0, 0, 5, 'x', '{}', ?3, ?3)`,
				id,
				PARTNER_ID,
				created,
			);
		}
		const broken = {
			put: async () => {
				throw new Error("r2 down");
			},
			list: async () => {
				throw new Error("r2 down");
			},
		} as unknown as R2Bucket;
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await cron({ SNAPSHOTS: broken });
		expect(error).toHaveBeenCalled();
		expect(await count("audit_daily_kpis")).toBe(1);
		const ids = (
			await env.DB.prepare("SELECT id FROM audit_events").all<{ id: string }>()
		).results.map((r) => r.id);
		expect(ids).toEqual(["k1"]);
	});
});

describe("age recipient", () => {
	it("全 mode の recipient が deploy.sh の検証パターンに通る", () => {
		const pattern = new RegExp(AGE_RECIPIENT_PATTERN);
		for (const r of Object.values(resources)) {
			expect(r.snapshotAgeRecipient).toMatch(pattern);
		}
		expect(resources.local.snapshotAgeRecipient).toBe(TEST_AGE_RECIPIENT);
		expect(env.SNAPSHOT_AGE_RECIPIENT).toBe(TEST_AGE_RECIPIENT);
	});

	it("プレースホルダや不正な値は検証パターンに通らない", () => {
		const pattern = new RegExp(AGE_RECIPIENT_PATTERN);
		for (const bad of [
			"",
			"REPLACE_WITH_AGE_RECIPIENT",
			"age1placeholder",
			"AGE-SECRET-KEY-1UQGWDU8C9AW57Q5RNA68L3J9LGLYUSYXXMQWYTENYGUESTNXMJKQX4KXX2",
		]) {
			expect(bad).not.toMatch(pattern);
		}
	});
});
