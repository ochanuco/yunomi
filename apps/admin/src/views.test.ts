import { describe, expect, it, vi } from "vitest";
import {
	auditItem,
	candidate,
	fact,
	relationship,
	status,
} from "./fixtures.ts";
import {
	renderAuditDrawer,
	renderAuditList,
	renderCandidates,
	renderError,
	renderFacts,
	renderStatus,
} from "./views.ts";

const HOSTILE = '<img src=x onerror="alert(1)"><script>boom()</script>';

describe("renderStatus", () => {
	it("State と件数と relationship を JST で出す", () => {
		const el = renderStatus(status, [relationship]);
		const text = el.textContent ?? "";
		expect(text).toContain("0.30");
		expect(text).toContain("2026-10-11 12:00:00");
		expect(text).toContain("alice");
		expect(text).toContain("pending candidates");
	});

	it("State も relationship も無いとき", () => {
		const text = renderStatus({ ...status, state: null }, []).textContent;
		expect(text).toContain("まだ State がない");
		expect(text).toContain("まだ関係がない");
	});

	it("表示名に HTML が入っていても要素にならない", () => {
		const el = renderStatus(status, [
			{ ...relationship, display_name: HOSTILE },
		]);
		expect(el.querySelector("img, script")).toBeNull();
		expect(el.textContent).toContain(HOSTILE);
	});
});

describe("memory", () => {
	it("Fact は現行かどうかを出す", () => {
		const el = renderFacts(
			[fact, { ...fact, id: "f2", superseded_by: "f3" }],
			new Date("2026-10-12T00:00:00Z"),
		);
		const text = el.textContent ?? "";
		expect(text).toContain("current");
		expect(text).toContain("superseded");
		expect(el.querySelectorAll("tbody tr")).toHaveLength(2);
	});

	it("candidate は話者を指さないとき subject_text を出す", () => {
		expect(renderCandidates([candidate]).textContent).toContain("友達");
		expect(
			renderCandidates([{ ...candidate, subject_text: null }]).textContent,
		).toContain("(話者)");
	});

	it("値に HTML が入っていても要素にならない", () => {
		const el = renderFacts(
			[{ ...fact, object_value: HOSTILE }],
			new Date("2026-10-12T00:00:00Z"),
		);
		expect(el.querySelector("img, script")).toBeNull();
	});

	it("空のとき", () => {
		expect(renderFacts([], new Date()).textContent).toContain("まだない");
		expect(renderCandidates([]).textContent).toContain("まだない");
	});
});

describe("audit", () => {
	it("一覧は行を選ぶと id を渡し、選択行を強調する", () => {
		const onSelect = vi.fn();
		const el = renderAuditList(
			[auditItem({ id: "a1" }), auditItem({ id: "a2" })],
			"a2",
			onSelect,
		);
		const rows = el.querySelectorAll<HTMLElement>("tbody tr");
		expect(rows).toHaveLength(2);
		rows[0]?.click();
		expect(onSelect).toHaveBeenCalledWith("a1");
		expect(rows[1]?.classList.contains("selected")).toBe(true);
	});

	it("fallback と degraded を理由の横に出す", () => {
		const el = renderAuditList(
			[auditItem({ fallback_used: true, degraded: true })],
			null,
			() => {},
		);
		expect(el.textContent).toContain("fallback");
		expect(el.textContent).toContain("degraded");
	});

	it("受信本文に HTML が入っていても要素にならない", () => {
		const item = auditItem({
			inbound_content: HOSTILE,
			detail: { note: HOSTILE },
		});
		const list = renderAuditList([item], null, () => {});
		const drawer = renderAuditDrawer(item, () => {});
		for (const el of [list, drawer]) {
			expect(el.querySelector("img, script")).toBeNull();
			expect(el.textContent).toContain("alert(1)");
		}
	});

	it("詳細に判断サマリ・token・detail の JSON を出し、閉じるを呼べる", () => {
		const onClose = vi.fn();
		const el = renderAuditDrawer(auditItem(), onClose);
		const text = el.textContent ?? "";
		expect(text).toContain("挨拶された");
		expect(text).toContain("in 100 / out 20");
		expect(text).toContain('"toolCalls": []');
		el.querySelector("button")?.click();
		expect(onClose).toHaveBeenCalled();
	});
});

describe("renderError", () => {
	it("alert role で出す", () => {
		expect(renderError("x").getAttribute("role")).toBe("alert");
	});
});
