import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api } from "./api.ts";
import { ApiError } from "./api.ts";
import { startApp } from "./app.ts";
import {
	auditItem,
	candidate,
	fact,
	relationship,
	stateHistory,
	status,
} from "./fixtures.ts";

const flush = () => new Promise((r) => setTimeout(r, 0));

const fakeApi = (over: Partial<Api> = {}): Api => ({
	status: async () => status,
	relationships: async () => ({ items: [relationship] }),
	stateHistory: async () => stateHistory,
	memory: async ({ kind }) =>
		kind === "facts"
			? { kind, items: [fact], next_cursor: null }
			: { kind, items: [candidate], next_cursor: null },
	audit: async () => ({ items: [auditItem()], next_cursor: null }),
	...over,
});

let stop: (() => void) | null = null;
afterEach(() => {
	stop?.();
	stop = null;
	location.hash = "";
});

const boot = async (hash: string, api: Api, interval = 10_000) => {
	location.hash = hash;
	const root = document.createElement("div");
	document.body.replaceChildren(root);
	stop = startApp(root, api, interval);
	await flush();
	return root;
};

describe("startApp", () => {
	it("既定で State を表示する", async () => {
		const root = await boot("", fakeApi());
		expect(root.textContent).toContain("alice");
		expect(root.querySelector('nav a[aria-current="page"]')?.textContent).toBe(
			"State",
		);
	});

	it("#/memory は Facts と Candidates を切り替える", async () => {
		const root = await boot("#/memory", fakeApi());
		expect(root.textContent).toContain("緑茶");
		location.hash = "#/memory?kind=candidates";
		await flush();
		expect(root.textContent).toContain("友達");
	});

	it("#/audit は行のクリックで詳細ドロワーを開閉する", async () => {
		const root = await boot("#/audit", fakeApi());
		expect(root.querySelector(".drawer")).toBeNull();
		root.querySelector<HTMLElement>("tbody tr")?.click();
		expect(root.querySelector(".drawer")?.textContent).toContain("挨拶された");
		expect(location.hash).toBe("#/audit?id=a1");
		root.querySelector<HTMLElement>(".drawer button")?.click();
		expect(root.querySelector(".drawer")).toBeNull();
	});

	it("取得に失敗したら状態行にエラーを出し、直前の表示を残す", async () => {
		let fail = false;
		const root = await boot(
			"#/state",
			fakeApi({
				status: async () => {
					if (fail) throw new ApiError("HTTP 401 missing_token");
					return status;
				},
			}),
			20,
		);
		fail = true;
		await new Promise((r) => setTimeout(r, 60));
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			"missing_token",
		);
		expect(root.textContent).toContain("alice");
	});

	it("表示中の画面を一定間隔で取り直す", async () => {
		const audit = vi.fn(async () => ({
			items: [auditItem()],
			next_cursor: null,
		}));
		await boot("#/audit", fakeApi({ audit }), 20);
		await new Promise((r) => setTimeout(r, 70));
		expect(audit.mock.calls.length).toBeGreaterThanOrEqual(3);
	});

	it("画面を切り替えたら前の画面のポーリングは止まる", async () => {
		const audit = vi.fn(async () => ({
			items: [auditItem()],
			next_cursor: null,
		}));
		await boot("#/audit", fakeApi({ audit }), 20);
		location.hash = "#/state";
		await flush();
		const before = audit.mock.calls.length;
		await new Promise((r) => setTimeout(r, 70));
		expect(audit.mock.calls.length).toBe(before);
	});

	it("次ページがあれば読み込みボタンで古い行を足す", async () => {
		const audit = vi.fn(async (q: { cursor?: string }) =>
			q.cursor
				? {
						items: [
							auditItem({ id: "old", created_at: "2026-10-10T00:00:00.000Z" }),
						],
						next_cursor: null,
					}
				: { items: [auditItem({ id: "new" })], next_cursor: "c1" },
		);
		const root = await boot("#/audit", fakeApi({ audit }));
		expect(root.querySelectorAll("tbody tr")).toHaveLength(1);
		root.querySelector<HTMLButtonElement>(".list > button")?.click();
		await flush();
		expect(root.querySelectorAll("tbody tr")).toHaveLength(2);
		expect(root.querySelector(".list > button")).toBeNull();
	});
});
