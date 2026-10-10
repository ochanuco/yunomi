import { env, exports } from "cloudflare:workers";
import { KpisResponseSchema } from "@yunomi/admin-contract";
import { lifestyleDay } from "@yunomi/core";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";

const NOW = new Date("2026-10-11T03:00:00Z");
const BOUNDARY = "05:00";

type Audit = {
	id: string;
	partner: string;
	at: string;
	decision?: "reply" | "ignore";
	latency?: number;
	fallback?: boolean;
	degraded?: boolean;
	error?: string | null;
	tokens?: [number, number, number, number];
};

const insertAudit = (a: Audit) => {
	const [i, o, cr, cw] = a.tokens ?? [0, 0, 0, 0];
	return env.DB.prepare(
		`INSERT INTO audit_events (id, partner_id, event_id, dedupe_key, channel_id, author_entity_id, kind, decision, reason, decision_summary, model, fallback_used, degraded, error_type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms, inbound_content, detail_json, occurred_at, created_at)
		VALUES (?1, ?2, ?1, ?1, 'c', NULL, 'turn', ?3, 'r', NULL, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'x', '{}', ?12, ?12)`,
	)
		.bind(
			a.id,
			a.partner,
			a.decision ?? "reply",
			a.fallback ? 1 : 0,
			a.degraded ? 1 : 0,
			a.error ?? null,
			i,
			o,
			cr,
			cw,
			a.latency ?? 0,
			a.at,
		)
		.run();
};

type Kpi = Record<string, string | number | null>;

const kpiRows = (partner: string) =>
	env.DB.prepare(
		"SELECT * FROM audit_daily_kpis WHERE partner_id = ? ORDER BY day",
	)
		.bind(partner)
		.all<Kpi>()
		.then((r) => r.results);

const cron = (at: Date) =>
	worker.scheduled(
		{ scheduledTime: at.getTime(), cron: "17 19 * * *", noRetry() {} },
		env,
	);

const seed = async (p: string) => {
	// 生活日 2026-10-10 は JST 05:00（2026-10-09T20:00Z）から翌 04:59:59 まで。
	await insertAudit({
		id: `${p}-d09`,
		partner: p,
		at: "2026-10-09T19:59:59.000Z",
		latency: 999,
	});
	await insertAudit({
		id: `${p}-r1`,
		partner: p,
		at: "2026-10-09T20:00:00.000Z",
		latency: 100,
		tokens: [10, 2, 1, 0],
	});
	await insertAudit({
		id: `${p}-r2`,
		partner: p,
		at: "2026-10-10T00:00:00.000Z",
		latency: 200,
		fallback: true,
		tokens: [20, 4, 2, 1],
	});
	await insertAudit({
		id: `${p}-r3`,
		partner: p,
		at: "2026-10-10T05:00:00.000Z",
		latency: 300,
		degraded: true,
		error: "timeout",
		tokens: [30, 6, 3, 2],
	});
	await insertAudit({
		id: `${p}-r4`,
		partner: p,
		at: "2026-10-10T10:00:00.000Z",
		latency: 400,
		tokens: [40, 8, 4, 3],
	});
	await insertAudit({
		id: `${p}-i1`,
		partner: p,
		at: "2026-10-10T19:59:59.000Z",
		decision: "ignore",
		latency: 5000,
	});
	// 進行中の生活日 2026-10-11。
	await insertAudit({
		id: `${p}-today`,
		partner: p,
		at: "2026-10-10T20:00:00.000Z",
	});
};

describe("日次 KPI の集計", () => {
	it("partner と生活日ごとに集計し、当日は含めない", async () => {
		await seed("kpi-a");
		await insertAudit({
			id: "kpi-b-1",
			partner: "kpi-b",
			at: "2026-10-10T01:00:00.000Z",
			latency: 50,
			tokens: [1, 1, 1, 1],
		});
		await cron(NOW);

		expect(await kpiRows("kpi-a")).toMatchObject([
			{ day: "2026-10-09", turns: 1, replies: 1, latency_p50_ms: 999 },
			{
				day: "2026-10-10",
				turns: 5,
				replies: 4,
				ignores: 1,
				errors: 1,
				degraded: 1,
				fallback_used: 1,
				latency_p50_ms: 200,
				latency_p95_ms: 400,
				input_tokens: 100,
				output_tokens: 20,
				cache_read_tokens: 10,
				cache_write_tokens: 6,
			},
		]);
		expect(await kpiRows("kpi-b")).toMatchObject([
			{ day: "2026-10-10", turns: 1, latency_p50_ms: 50, input_tokens: 1 },
		]);
	});

	it("reply が無い日の latency は null", async () => {
		await insertAudit({
			id: "kpi-n-1",
			partner: "kpi-n",
			at: "2026-10-10T01:00:00.000Z",
			decision: "ignore",
		});
		await cron(NOW);
		expect(await kpiRows("kpi-n")).toMatchObject([
			{ turns: 1, latency_p50_ms: null, latency_p95_ms: null },
		]);
	});

	it("同じ日を何度集計しても結果は同じで、後から増えた行は反映される", async () => {
		await seed("kpi-idem");
		await cron(NOW);
		const strip = (rows: Kpi[]) => rows.map(({ updated_at: _, ...r }) => r);
		const once = strip(await kpiRows("kpi-idem"));
		await cron(NOW);
		await cron(new Date(NOW.getTime() + 60_000));
		expect(strip(await kpiRows("kpi-idem"))).toEqual(once);

		await insertAudit({
			id: "kpi-idem-late",
			partner: "kpi-idem",
			at: "2026-10-10T02:00:00.000Z",
			latency: 10,
		});
		await cron(NOW);
		const day = (await kpiRows("kpi-idem")).find((r) => r.day === "2026-10-10");
		expect(day?.turns).toBe(6);
	});

	it("cron は 04:17 JST に走るので、生活日は翌日の cron で確定する", async () => {
		await insertAudit({
			id: "kpi-next-1",
			partner: "kpi-next",
			at: "2026-10-10T20:00:00.000Z",
		});
		await cron(NOW);
		expect(await kpiRows("kpi-next")).toEqual([]);
		await cron(new Date("2026-10-11T19:17:00Z"));
		expect(await kpiRows("kpi-next")).toEqual([]);
		await cron(new Date("2026-10-12T19:17:00Z"));
		expect(await kpiRows("kpi-next")).toMatchObject([
			{ day: "2026-10-11", turns: 1 },
		]);
	});

	it("集計が失敗したら audit を削除しない（集計してから削除する順序）", async () => {
		const p = "kpi-fail";
		await insertAudit({
			id: `${p}-old`,
			partner: p,
			at: "2026-09-01T00:00:00.000Z",
		});
		await env.DB.exec("ALTER TABLE audit_daily_kpis RENAME TO kpi_tmp");
		try {
			await expect(cron(NOW)).rejects.toThrow();
		} finally {
			await env.DB.exec("ALTER TABLE kpi_tmp RENAME TO audit_daily_kpis");
		}
		const left = await env.DB.prepare(
			"SELECT id FROM audit_events WHERE partner_id = ?",
		)
			.bind(p)
			.all();
		expect(left.results).toHaveLength(1);
	});
});

const KPI_BASE = "/admin/api/partners/yukarin/kpis";
const local = (path: string, headers: Record<string, string>) =>
	exports.default.fetch(new Request(`http://localhost${path}`, { headers }));
const asYkm = { "x-yunomi-dev-caller": "ykm" };

const insertKpi = (day: string, turns: number) =>
	env.DB.prepare(
		`INSERT INTO audit_daily_kpis (partner_id, day, turns, replies, ignores, errors, degraded, fallback_used, latency_p50_ms, latency_p95_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, updated_at)
		VALUES ('yukarin', ?1, ?2, ?2, 0, 0, 0, 0, 100, 200, 1, 2, 3, 4, '2026-01-01T00:00:00Z')`,
	)
		.bind(day, turns)
		.run();

const daysAgo = (n: number) =>
	lifestyleDay(new Date(Date.now() - n * 24 * 60 * 60 * 1000), BOUNDARY);

describe("GET /kpis", () => {
	it("認証なしは 401、gateway は 403", async () => {
		expect((await local(KPI_BASE, {})).status).toBe(401);
		expect(
			(await local(KPI_BASE, { "x-yunomi-dev-caller": "gateway" })).status,
		).toBe(403);
	});

	it("days の範囲内を新しい日から返し、スキーマに一致する", async () => {
		await insertKpi(daysAgo(1), 1);
		await insertKpi(daysAgo(3), 3);
		await insertKpi(daysAgo(20), 20);

		const res = await local(`${KPI_BASE}?days=5`, asYkm);
		expect(res.status).toBe(200);
		const r = v.parse(KpisResponseSchema, await res.json());
		expect(r.items.map((i) => i.turns)).toEqual([1, 3]);
		expect(r.items[0]).toMatchObject({
			day: daysAgo(1),
			latency_p50_ms: 100,
			usage: {
				input_tokens: 1,
				output_tokens: 2,
				cache_read_tokens: 3,
				cache_write_tokens: 4,
			},
		});

		const dflt = await local(KPI_BASE, asYkm);
		const body = v.parse(KpisResponseSchema, await dflt.json());
		expect(body.items.map((i) => i.turns)).toEqual([1, 3, 20]);
	});

	it("不正な days は 400", async () => {
		for (const q of ["0", "366", "abc", "1.5"]) {
			expect((await local(`${KPI_BASE}?days=${q}`, asYkm)).status, q).toBe(400);
		}
	});

	it("未知の partner は 404", async () => {
		const res = await local("/admin/api/partners/nobody/kpis", asYkm);
		expect(res.status).toBe(404);
	});
});
