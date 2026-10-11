import { describe, expect, it } from "vitest";
import {
	auditItem,
	candidate,
	fact,
	interest,
	openLoop,
	opinion,
	relationship,
	status,
} from "./fixtures.ts";
import {
	auditHeader,
	displayWidth,
	formatAuditRow,
	formatCandidates,
	formatFacts,
	formatInterests,
	formatOpenLoops,
	formatOpinions,
	formatStatus,
	jst,
	table,
	truncate,
} from "./format.ts";

describe("jst", () => {
	it("UTC を JST に直して秒まで出す", () => {
		expect(jst("2026-10-11T15:30:05.123Z")).toBe("2026-10-12 00:30:05");
	});
	it("null と不正な値", () => {
		expect(jst(null)).toBe("-");
		expect(jst("bad")).toBe("bad");
	});
});

describe("表示幅", () => {
	it("全角は 2 として数える", () => {
		expect(displayWidth("abc")).toBe(3);
		expect(displayWidth("緑茶")).toBe(4);
	});

	it("truncate は表示幅で切り、改行を空白にする", () => {
		expect(truncate("a\nb", 10)).toBe("a b");
		expect(truncate("あいうえお", 6)).toBe("あい…");
		expect(truncate("short", 10)).toBe("short");
	});

	it("table は全角を含む列も揃える", () => {
		const out = table(
			["A", "B"],
			[
				["緑茶", "x"],
				["abcd", "y"],
			],
		).split("\n");
		expect(
			out.map((l) => displayWidth(l.slice(0, l.lastIndexOf("  ")))),
		).toEqual([4, 4, 4]);
	});
});

describe("formatStatus", () => {
	it("state と relationship を JST で並べる", () => {
		const out = formatStatus(status, [relationship]);
		expect(out).toContain("mood 0.30  energy 0.50");
		expect(out).toContain("updated 2026-10-11 12:00:00 JST");
		expect(out).toContain("facts 3, pending candidates 1");
		expect(out).toMatch(/alice\s+0\.12\s+0\.32\s+2026-10-11 12:00:00/);
	});

	it("state が無いとき", () => {
		expect(formatStatus({ ...status, state: null }, [])).toContain(
			"state     (まだ無い)",
		);
	});
});

describe("memory", () => {
	it("Fact は現行かどうかを state 列に出す", () => {
		const out = formatFacts(
			[fact, { ...fact, id: "f2", superseded_by: "f3" }],
			new Date("2026-10-12T00:00:00Z"),
		);
		expect(out).toContain("current");
		expect(out).toContain("superseded");
		expect(out).toContain("緑茶");
	});

	it("candidate は話者を指さないとき subject_text を出す", () => {
		expect(formatCandidates([candidate])).toContain("友達");
		expect(formatCandidates([{ ...candidate, subject_text: null }])).toContain(
			"(speaker)",
		);
	});

	it("空のとき", () => {
		expect(formatFacts([], new Date())).toBe("(Fact なし)");
		expect(formatCandidates([])).toBe("(candidate なし)");
	});
});

describe("audit", () => {
	it("行は header と同じ列位置に揃う", () => {
		const header = auditHeader();
		const row = formatAuditRow(auditItem());
		expect(row.indexOf("reply")).toBe(header.indexOf("DECISION"));
		expect(row.indexOf("llm")).toBe(header.indexOf("REASON"));
		expect(row).toContain("haiku-4-5");
		expect(row).toContain("100/20");
		expect(row).toContain("2026-10-11 12:00:01");
	});

	it("fallback と degraded を FLAGS に出す", () => {
		const row = formatAuditRow(
			auditItem({ fallback_used: true, degraded: true }),
		);
		expect(row).toContain("fallback,degraded");
	});
});

describe("formatOpenLoops", () => {
	it("時刻は JST で、期限が無ければ - を出す", () => {
		const out = formatOpenLoops([
			openLoop,
			{
				...openLoop,
				id: "ol2",
				status: "resolved",
				due_at: null,
				due_confidence: null,
				entity_display_name: null,
			},
		]);
		expect(out).toContain("2026-10-12 00:30:00");
		expect(out).toContain("open");
		expect(out).toContain("resolved");
		expect(out).toContain("0.60");
		expect(out.split("\n")[2]).toMatch(/-\s+-$/);
	});

	it("空のときは明示する", () => {
		expect(formatOpenLoops([])).toBe("(Open Loop なし)");
	});
});

describe("formatInterests / formatOpinions", () => {
	it("Interest は score・baseline・差分を符号付きで、未学習は updated を - にする", () => {
		const out = formatInterests([
			interest,
			{
				...interest,
				topic: "words",
				label: "言葉",
				score: 0.5,
				baseline: 0.5,
				learned_delta: 0,
				updated_at: null,
				source: "profile",
			},
		]);
		expect(out).toContain("0.73");
		expect(out).toContain("+0.03");
		expect(out).toContain("2026-10-11 12:00:00");
		expect(out.split("\n")[2]).toMatch(
			/words.*0\.50\s+0\.50\s+0\.00\s+profile\s+-$/,
		);
	});

	it("Opinion は stance と confidence / stability を出す", () => {
		const out = formatOpinions([opinion]);
		expect(out).toContain("知らないことは知らないと言うほうがよい。");
		expect(out).toContain("0.80");
		expect(out).toContain("0.85");
	});

	it("空のときは明示する", () => {
		expect(formatInterests([])).toBe("(Interest なし)");
		expect(formatOpinions([])).toBe("(Opinion なし)");
	});
});
