import { describe, expect, it } from "vitest";
import { type Deps, run } from "./commands.ts";
import {
	auditItem,
	candidate,
	fact,
	interest,
	kpiDay,
	openLoop,
	opinion,
	relationship,
	stateHistory,
	status,
} from "./fixtures.ts";

const harness = (routes: (url: URL) => unknown, over: Partial<Deps> = {}) => {
	const out: string[] = [];
	const err: string[] = [];
	const urls: URL[] = [];
	const controller = new AbortController();
	const deps: Deps = {
		fetch: async (input) => {
			const url = new URL(input);
			urls.push(url);
			return Response.json(routes(url));
		},
		env: {
			YKM_DEV_URL: "https://yunomi-dev.example.test",
			YKM_ACCESS_CLIENT_ID: "id",
			YKM_ACCESS_CLIENT_SECRET: "s",
		},
		out: (t) => out.push(t),
		err: (t) => err.push(t),
		now: () => new Date("2026-10-11T03:00:00Z"),
		sleep: async () => {},
		signal: controller.signal,
		writeFile: async () => {},
		...over,
	};
	return { deps, out, err, urls, controller };
};

const api = (url: URL) => {
	const path = url.pathname.replace("/admin/api/partners/yukarin/", "");
	if (path === "status") return status;
	if (path === "relationships") return { items: [relationship] };
	if (path === "open-loops") {
		return { items: [openLoop], next_cursor: null };
	}
	if (path === "interests") return { items: [interest] };
	if (path === "opinions") return { items: [opinion] };
	if (path === "state-history") return stateHistory;
	if (path === "kpis") return { items: [kpiDay] };
	if (path === "memory") {
		return url.searchParams.get("kind") === "candidates"
			? { kind: "candidates", items: [candidate], next_cursor: null }
			: { kind: "facts", items: [fact], next_cursor: null };
	}
	return { items: [auditItem()], next_cursor: null };
};

describe("run", () => {
	it("status は整形して出す", async () => {
		const h = harness(api);
		expect(await run(["status"], h.deps)).toBe(0);
		expect(h.out.join("\n")).toContain("alice");
	});

	it("status --json は status と relationships をまとめた JSON", async () => {
		const h = harness(api);
		await run(["status", "--json"], h.deps);
		const parsed = JSON.parse(h.out[0] ?? "");
		expect(parsed.status.partner_id).toBe("yukarin");
		expect(parsed.relationships).toHaveLength(1);
	});

	it("memory list は既定で Fact、--candidates で candidate を引く", async () => {
		const h = harness(api);
		await run(["memory", "list", "--limit", "3"], h.deps);
		await run(["memory", "list", "--candidates"], h.deps);
		expect(h.urls.map((u) => u.searchParams.get("kind"))).toEqual([
			"facts",
			"candidates",
		]);
		expect(h.urls[0]?.searchParams.get("limit")).toBe("3");
		expect(h.out[0]).toContain("緑茶");
		expect(h.out[1]).toContain("友達");
	});

	it("memory list --all は include=all を付け、既定では付けない", async () => {
		const h = harness(api);
		await run(["memory", "list"], h.deps);
		await run(["memory", "list", "--all"], h.deps);
		expect(h.urls[0]?.searchParams.get("include")).toBeNull();
		expect(h.urls[1]?.searchParams.get("include")).toBe("all");
	});

	it("open-loops は既定で status を付けず、--all で status=all を付ける", async () => {
		const h = harness(api);
		expect(await run(["open-loops"], h.deps)).toBe(0);
		await run(["open-loops", "--all", "--limit", "5"], h.deps);
		expect(h.urls[0]?.pathname).toBe("/admin/api/partners/yukarin/open-loops");
		expect(h.urls[0]?.searchParams.get("status")).toBeNull();
		expect(h.urls[1]?.searchParams.get("status")).toBe("all");
		expect(h.urls[1]?.searchParams.get("limit")).toBe("5");
		expect(h.out[0]).toContain("明日の面接の結果");
		expect(h.out[0]).toContain("2026-10-12 00:30:00");
	});

	it("open-loops --json は応答をそのまま出す", async () => {
		const h = harness(api);
		await run(["open-loops", "--json"], h.deps);
		expect(JSON.parse(h.out[0] ?? "").items[0].id).toBe("ol1");
	});

	it("open-loops の応答が契約に合わなければ 1", async () => {
		const h = harness(() => ({ items: [{ id: "x" }], next_cursor: null }));
		expect(await run(["open-loops"], h.deps)).toBe(1);
		expect(h.err.join("\n")).toContain("admin-contract");
	});

	it("interests / opinions は表で出す", async () => {
		const h = harness(api);
		expect(await run(["interests"], h.deps)).toBe(0);
		expect(h.urls[0]?.pathname).toBe("/admin/api/partners/yukarin/interests");
		expect(h.out[0]).toContain("music-voice");
		expect(h.out[0]).toContain("+0.03");
		expect(h.out[0]).toContain("learned");
		expect(await run(["opinions"], h.deps)).toBe(0);
		expect(h.urls[1]?.pathname).toBe("/admin/api/partners/yukarin/opinions");
		expect(h.out[1]).toContain("honesty");
		expect(h.out[1]).toContain("0.80");
		expect(h.out[1]).toContain("profile");
	});

	it("interests / opinions --json は応答をそのまま出す", async () => {
		const h = harness(api);
		await run(["interests", "--json"], h.deps);
		await run(["opinions", "--json"], h.deps);
		expect(JSON.parse(h.out[0] ?? "").items[0].topic).toBe("music-voice");
		expect(JSON.parse(h.out[1] ?? "").items[0].topic).toBe("honesty");
	});

	it("interests の応答が契約に合わなければ 1", async () => {
		const h = harness(() => ({ items: [{ topic: "x" }] }));
		expect(await run(["interests"], h.deps)).toBe(1);
		expect(h.err.join("\n")).toContain("admin-contract");
	});

	it("kpi は days を渡して表で出す", async () => {
		const h = harness(api);
		expect(await run(["kpi", "--days", "7"], h.deps)).toBe(0);
		expect(h.urls[0]?.pathname).toBe("/admin/api/partners/yukarin/kpis");
		expect(h.urls[0]?.searchParams.get("days")).toBe("7");
		expect(h.out[0]).toContain("2026-10-10");
		expect(h.out[0]).toContain("3400");
	});

	it("kpi --json は応答をそのまま出す", async () => {
		const h = harness(api);
		await run(["kpi", "--json"], h.deps);
		expect(h.urls[0]?.searchParams.get("days")).toBe("30");
		expect(JSON.parse(h.out[0] ?? "").items[0].turns).toBe(10);
	});

	it("state-history は days を渡して要約と変化を出す", async () => {
		const h = harness(api);
		expect(await run(["state-history", "--days", "3"], h.deps)).toBe(0);
		expect(h.urls[0]?.pathname).toBe(
			"/admin/api/partners/yukarin/state-history",
		);
		expect(h.urls[0]?.searchParams.get("days")).toBe("3");
		expect(h.out[0]).toContain("mood");
		expect(h.out[0]).toContain("alice");
	});

	it("state-history --json は応答をそのまま出す", async () => {
		const h = harness(api);
		await run(["state-history", "--json"], h.deps);
		expect(h.urls[0]?.searchParams.get("days")).toBe("7");
		expect(JSON.parse(h.out[0] ?? "").transitions).toHaveLength(2);
	});

	it("state-history の応答が契約に合わなければ 1", async () => {
		const h = harness(() => ({ since: "x" }));
		expect(await run(["state-history"], h.deps)).toBe(1);
		expect(h.err.join("\n")).toContain("admin-contract");
	});

	it("audit tail は古い順に出す", async () => {
		const items = [
			auditItem({
				id: "n",
				created_at: "2026-10-11T03:00:02.000Z",
				inbound_content: "new",
			}),
			auditItem({
				id: "o",
				created_at: "2026-10-11T03:00:01.000Z",
				inbound_content: "old",
			}),
		];
		const h = harness(() => ({ items, next_cursor: null }));
		await run(["audit", "tail", "-n", "2"], h.deps);
		const text = h.out.join("\n");
		expect(text.indexOf("old")).toBeLessThan(text.indexOf("new"));
		expect(h.urls).toHaveLength(1);
	});

	it("audit tail -f は since で追加分だけを重複なく出す", async () => {
		const a1 = auditItem({
			id: "a1",
			created_at: "2026-10-11T03:00:01.000Z",
			inbound_content: "first",
		});
		const a2 = auditItem({
			id: "a2",
			created_at: "2026-10-11T03:00:01.000Z",
			inbound_content: "same-ts",
		});
		const a3 = auditItem({
			id: "a3",
			created_at: "2026-10-11T03:00:09.000Z",
			inbound_content: "later",
		});
		let round = 0;
		const h = harness((url) => {
			round++;
			if (round === 1) return { items: [a1], next_cursor: null };
			if (round === 2) return { items: [a2, a1], next_cursor: null };
			return {
				items: [a3, a2, a1].filter(
					(i) => i.created_at >= (url.searchParams.get("since") ?? ""),
				),
				next_cursor: null,
			};
		});
		let sleeps = 0;
		h.deps.sleep = async (ms) => {
			expect(ms).toBe(5000);
			if (++sleeps === 3) h.controller.abort();
		};
		await run(["audit", "tail", "-n", "1", "-f"], h.deps);

		const text = h.out.join("\n");
		expect(text.match(/first/g)).toHaveLength(1);
		expect(text.match(/same-ts/g)).toHaveLength(1);
		expect(text.match(/later/g)).toHaveLength(1);
		expect(h.urls[1]?.searchParams.get("since")).toBe(
			"2026-10-11T03:00:01.000Z",
		);
		expect(h.urls[2]?.searchParams.get("since")).toBe(
			"2026-10-11T03:00:01.000Z",
		);
	});

	it("使い方の誤りは 2、接続・認可の失敗は 1", async () => {
		const bad = harness(api);
		expect(await run(["nope"], bad.deps)).toBe(2);

		const noToken = harness(api, {
			env: { YKM_DEV_URL: "https://yunomi-dev.example.test" },
		});
		expect(await run(["status"], noToken.deps)).toBe(1);
		expect(noToken.err.join()).toContain("YKM_ACCESS_CLIENT_ID");

		const denied = harness(api, {
			fetch: async () => Response.json({ error: "forbidden" }, { status: 403 }),
		});
		expect(await run(["status"], denied.deps)).toBe(1);
		expect(denied.err.join()).toContain("403");
	});

	it("localhost 宛ては token 無しで dev caller を送る", async () => {
		const seen: Record<string, string>[] = [];
		const h = harness(api, {
			env: {},
			fetch: async (_u, init) => {
				seen.push(init?.headers as Record<string, string>);
				return Response.json(
					api(new URL("http://x/admin/api/partners/yukarin/status")),
				);
			},
		});
		await run(["status", "--url", "http://localhost:8787"], h.deps);
		expect(seen[0]?.["x-yunomi-dev-caller"]).toBe("ykm");
	});
});
