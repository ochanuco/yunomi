import { describe, expect, it } from "vitest";
import { extractUrls, isUrlFromSource } from "./source-urls.ts";

describe("extractUrls", () => {
	it("本文の http(s) の URL を拾い、fragment を落として正規化する", () => {
		expect(
			extractUrls(
				"これ読んで https://example.com/a?b=1#top と <http://Example.com/x>",
			),
		).toEqual(["https://example.com/a?b=1", "http://example.com/x"]);
	});

	it("文末の句読点や括弧は、付けた形と外した形の両方を候補にする", () => {
		expect(extractUrls("(https://example.com/a).")).toEqual([
			"https://example.com/a).",
			"https://example.com/a",
		]);
	});

	it("後ろに続く日本語は URL に含めない", () => {
		expect(extractUrls("https://example.com/aを読んで")).toEqual([
			"https://example.com/a",
		]);
	});

	it("JSON の文字列に入った URL も拾う", () => {
		expect(
			extractUrls(JSON.stringify({ final_url: "https://example.com/p?id=1" })),
		).toEqual(["https://example.com/p?id=1"]);
	});

	it("URL が無ければ空", () => {
		expect(extractUrls("ftp://example.com と example.com")).toEqual([]);
	});
});

describe("isUrlFromSource", () => {
	const sources = extractUrls("https://example.com/post?id=1");

	it("fragment の違いだけなら一致とみなす", () => {
		expect(isUrlFromSource("https://example.com/post?id=1#c", sources)).toBe(
			true,
		);
	});

	it("クエリやパスを足した URL は一致しない", () => {
		expect(
			isUrlFromSource("https://example.com/post?id=1&d=secret", sources),
		).toBe(false);
		expect(isUrlFromSource("https://example.com/post/secret", sources)).toBe(
			false,
		);
		expect(isUrlFromSource("https://attacker.example/?d=x", sources)).toBe(
			false,
		);
	});

	it("URL として読めない値は一致しない", () => {
		expect(isUrlFromSource("not a url", sources)).toBe(false);
	});
});
