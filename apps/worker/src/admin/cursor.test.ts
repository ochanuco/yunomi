import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor.ts";

describe("cursor", () => {
	it("encode したものを decode できる", () => {
		const c = { at: "2026-10-11T03:00:00.000Z", id: "0199-abc" };
		expect(decodeCursor(encodeCursor(c))).toEqual(c);
	});

	it("base64url で、パディングや URL 不安全文字を含まない", () => {
		expect(
			encodeCursor({ at: "2026-10-11T03:00:00.000Z", id: "???>>>" }),
		).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("壊れた cursor は null", () => {
		for (const raw of [
			"",
			"!!!",
			btoa("no-separator"),
			btoa("not-a-date|id"),
		]) {
			expect(decodeCursor(raw)).toBeNull();
		}
	});
});
