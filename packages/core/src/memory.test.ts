import { describe, expect, it } from "vitest";
import {
	decidePromotion,
	normalizeObject,
	normalizePredicate,
	type PromotionInput,
} from "./memory.ts";

describe("normalizePredicate", () => {
	it("trim・ASCII 小文字化・空白の圧縮", () => {
		expect(normalizePredicate("  Favorite   Drink ")).toBe("favorite drink");
	});

	it("日本語はそのまま", () => {
		expect(normalizePredicate(" 好きな　飲み物 ")).toBe("好きな 飲み物");
	});
});

describe("normalizeObject", () => {
	it("型に合う値を正規化する", () => {
		expect(normalizeObject({ type: "number", value: " 42.0 " })).toEqual({
			type: "number",
			value: "42",
		});
		expect(normalizeObject({ type: "boolean", value: "TRUE" })).toEqual({
			type: "boolean",
			value: "true",
		});
		expect(
			normalizeObject({ type: "datetime", value: "2026-10-11T12:00:00+09:00" }),
		).toEqual({ type: "datetime", value: "2026-10-11T03:00:00.000Z" });
		expect(normalizeObject({ type: "string", value: " 緑茶 " })).toEqual({
			type: "string",
			value: "緑茶",
		});
	});

	it.each([
		{ type: "number", value: "abc" },
		{ type: "boolean", value: "yes" },
		{ type: "datetime", value: "いつか" },
		{ type: "string", value: "  " },
		{ type: "entity", value: "" },
	] as const)("型に合わない値は null: %o", (o) => {
		expect(normalizeObject(o)).toBeNull();
	});
});

describe("decidePromotion", () => {
	const base: PromotionInput = {
		source: "user_statement",
		confidence: 0.9,
		subjectIsSpeaker: true,
		object: { type: "string", value: "緑茶" },
		current: null,
	};

	it("現行 Fact が無ければ insert で昇格", () => {
		expect(decidePromotion(base)).toEqual({
			status: "promoted",
			action: "insert",
		});
	});

	it("confidence 0.8 ちょうどは昇格する", () => {
		expect(decidePromotion({ ...base, confidence: 0.8 }).status).toBe(
			"promoted",
		);
	});

	it("同じ値なら refresh", () => {
		expect(
			decidePromotion({
				...base,
				current: { id: "f1", object: { type: "string", value: "緑茶" } },
			}),
		).toEqual({ status: "promoted", action: "refresh", factId: "f1" });
	});

	it("値が違えば conflict（自動置換しない）", () => {
		expect(
			decidePromotion({
				...base,
				current: { id: "f1", object: { type: "string", value: "紅茶" } },
			}),
		).toEqual({ status: "conflict", conflictFactId: "f1" });
	});

	it("型が違う同値も別物として conflict", () => {
		expect(
			decidePromotion({
				...base,
				object: { type: "number", value: "1" },
				current: { id: "f1", object: { type: "string", value: "1" } },
			}).status,
		).toBe("conflict");
	});

	it.each([
		["inferred", { source: "inferred" as const }],
		["confidence 不足", { confidence: 0.79 }],
		["NaN の confidence", { confidence: Number.NaN }],
		["話者以外が主語", { subjectIsSpeaker: false }],
	])("%s は pending", (_n, over) => {
		expect(decidePromotion({ ...base, ...over })).toEqual({
			status: "pending",
		});
	});
});
