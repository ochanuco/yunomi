import { toJsonSchema } from "@valibot/to-json-schema";
import { describe, expect, it } from "vitest";
import { parseToolInput } from "../input.ts";
import { decide } from "../policy.ts";
import { calendarCreateEvent, calendarListEvents } from "./calendar.ts";

const issuesOf = (r: ReturnType<typeof parseToolInput>): readonly string[] => {
	if (r.ok || r.error.type !== "ValidationFailed") {
		throw new Error("ValidationFailed のはず");
	}
	return r.error.issues;
};

describe("calendar_list_events", () => {
	const parse = (raw: unknown) => parseToolInput(calendarListEvents, raw);

	it("カテゴリと名前が決まっている", () => {
		expect(calendarListEvents.name).toBe("calendar_list_events");
		expect(calendarListEvents.category).toBe("calendar_read");
	});

	it("オフセット付きと Z の期間を受け付ける", () => {
		const input = {
			from: "2026-10-18T00:00:00+09:00",
			to: "2026-10-19T00:00:00+09:00",
		};
		expect(parse(input)).toEqual({ ok: true, value: input });
		expect(
			parse({ from: "2026-10-18T00:00:00Z", to: "2026-10-18T12:30:00.500Z" })
				.ok,
		).toBe(true);
	});

	it("ちょうど 31 日の期間は受け付け、31 日を超えると拒否する", () => {
		expect(
			parse({
				from: "2026-10-01T00:00:00+09:00",
				to: "2026-11-01T00:00:00+09:00",
			}).ok,
		).toBe(true);
		const issues = issuesOf(
			parse({
				from: "2026-10-01T00:00:00+09:00",
				to: "2026-11-02T00:00:00+09:00",
			}),
		);
		expect(issues).toEqual(["to: 期間は 31 日以内にする"]);
	});

	it("from が to 以降だと拒否する", () => {
		const reversed = issuesOf(
			parse({
				from: "2026-10-19T00:00:00+09:00",
				to: "2026-10-18T00:00:00+09:00",
			}),
		);
		expect(reversed).toEqual(["to: to は from より後の日時にする"]);
		const same = issuesOf(
			parse({
				from: "2026-10-18T00:00:00+09:00",
				to: "2026-10-18T00:00:00+09:00",
			}),
		);
		expect(same).toEqual(["to: to は from より後の日時にする"]);
	});

	it("タイムゾーンが無い日時を拒否する", () => {
		const issues = issuesOf(
			parse({ from: "2026-10-18T00:00:00", to: "2026-10-19T00:00:00" }),
		);
		expect(issues).toHaveLength(2);
		expect(issues[0]).toMatch(/^from: /);
		expect(issues[1]).toMatch(/^to: /);
	});

	it("不正な日時を拒否する", () => {
		for (const bad of [
			"2026-02-31T00:00:00+09:00",
			"2026-13-01T00:00:00+09:00",
			"2026-10-18T24:00:00+09:00",
			"2026-10-18T00:60:00+09:00",
			"2026-10-18T00:00:00+0900",
			"2026-10-18",
			"明日",
			"",
		]) {
			expect(
				parse({ from: bad, to: "2026-10-19T00:00:00+09:00" }).ok,
				bad,
			).toBe(false);
		}
	});

	it("閏日は 4 年に 1 度だけ実在する", () => {
		const to = "2028-03-02T00:00:00Z";
		expect(parse({ from: "2028-02-29T00:00:00Z", to }).ok).toBe(true);
		expect(parse({ from: "2026-02-29T00:00:00Z", to }).ok).toBe(false);
	});

	it("フィールドの不足と型違いを拒否する", () => {
		expect(parse({ from: "2026-10-18T00:00:00+09:00" }).ok).toBe(false);
		expect(parse({ from: 1, to: 2 }).ok).toBe(false);
		expect(parse(null).ok).toBe(false);
	});
});

describe("calendar_create_event", () => {
	const parse = (raw: unknown) => parseToolInput(calendarCreateEvent, raw);
	const valid = {
		summary: "歯医者",
		start: "2026-10-18T19:00:00+09:00",
		end: "2026-10-18T20:00:00+09:00",
		description: null,
	};

	it("カテゴリと名前が決まっていて、説明に了承の流れが書かれている", () => {
		expect(calendarCreateEvent.name).toBe("calendar_create_event");
		expect(calendarCreateEvent.category).toBe("calendar_write");
		expect(calendarCreateEvent.description).toContain("了承");
	});

	it("description が null でも文字列でも受け付ける", () => {
		expect(parse(valid)).toEqual({ ok: true, value: valid });
		expect(parse({ ...valid, description: "予約番号 12" }).ok).toBe(true);
	});

	it.each(["", "  　"])(
		"summary が空か空白だけだと拒否する（%j）",
		(summary) => {
			const issues = issuesOf(parse({ ...valid, summary }));
			expect(issues).toHaveLength(1);
			expect(issues[0]).toMatch(/^summary: /);
		},
	);

	it("summary は 200 文字、description は 2000 文字まで", () => {
		expect(parse({ ...valid, summary: "あ".repeat(200) }).ok).toBe(true);
		expect(parse({ ...valid, summary: "あ".repeat(201) }).ok).toBe(false);
		expect(parse({ ...valid, description: "あ".repeat(2000) }).ok).toBe(true);
		expect(parse({ ...valid, description: "あ".repeat(2001) }).ok).toBe(false);
	});

	it("end が start 以前だと拒否する", () => {
		expect(
			issuesOf(parse({ ...valid, end: "2026-10-18T18:00:00+09:00" })),
		).toEqual(["end: end は start より後の日時にする"]);
		expect(parse({ ...valid, end: valid.start }).ok).toBe(false);
	});

	it("タイムゾーンの異なる表記でも実時刻で前後を比べる", () => {
		expect(
			parse({
				...valid,
				start: "2026-10-18T19:00:00+09:00",
				end: "2026-10-18T10:30:00Z",
			}).ok,
		).toBe(true);
		expect(
			parse({
				...valid,
				start: "2026-10-18T19:00:00+09:00",
				end: "2026-10-18T10:00:00Z",
			}).ok,
		).toBe(false);
	});

	it("不正な日時とタイムゾーン無しを拒否する", () => {
		expect(parse({ ...valid, start: "2026-02-30T19:00:00+09:00" }).ok).toBe(
			false,
		);
		expect(parse({ ...valid, end: "2026-10-18T20:00:00" }).ok).toBe(false);
	});

	it("description の欠落（optional）は拒否する", () => {
		const { description: _omit, ...rest } = valid;
		expect(parse(rest).ok).toBe(false);
	});
});

describe("道具の定義と JSON Schema", () => {
	it.each([
		["calendar_list_events", calendarListEvents],
		["calendar_create_event", calendarCreateEvent],
	])("%s は errorMode ignore で JSON Schema に変換できる", (_name, def) => {
		const schema = toJsonSchema(def.input as never, {
			errorMode: "ignore",
		}) as {
			type: string;
			properties: Record<string, unknown>;
			required: string[];
		};
		expect(schema.type).toBe("object");
		expect(schema.required.slice().sort()).toEqual(
			Object.keys(schema.properties).sort(),
		);
	});

	it("create の description は null を許す型で表される", () => {
		const schema = toJsonSchema(calendarCreateEvent.input as never, {
			errorMode: "ignore",
		}) as { properties: { description: { anyOf: { type: string }[] } } };
		expect(
			schema.properties.description.anyOf.map((s) => s.type).sort(),
		).toEqual(["null", "string"]);
	});

	it("道具の名前は snake_case で、全 category を policy で判定できる", () => {
		const policy = {
			calendar_read: "auto",
			calendar_write: "confirm",
		} as const;
		for (const def of [calendarListEvents, calendarCreateEvent]) {
			expect(def.name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
			expect(decide(policy, def, { isOwner: true }).type).not.toBe("deny");
		}
	});
});
