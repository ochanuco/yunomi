import { describe, expect, it } from "vitest";
import type { Global } from "./args.ts";
import { ConfigError, resolveTarget } from "./config.ts";

const g = (over: Partial<Global> = {}): Global => ({
	env: "dev",
	url: null,
	partner: "yukarin",
	json: false,
	...over,
});
const token = {
	YKM_ACCESS_CLIENT_ID: "id",
	YKM_ACCESS_CLIENT_SECRET: "secret",
};

describe("resolveTarget", () => {
	it("env ごとの既定 URL と service token ヘッダ", () => {
		expect(resolveTarget(g(), token)).toEqual({
			baseUrl: "https://yunomi-dev.chanu.co",
			headers: {
				"CF-Access-Client-Id": "id",
				"CF-Access-Client-Secret": "secret",
			},
		});
		expect(resolveTarget(g({ env: "prod" }), token).baseUrl).toBe(
			"https://yunomi.chanu.co",
		);
	});

	it("env 別の service token を共通の指定より優先する", () => {
		const env = {
			...token,
			YKM_DEV_ACCESS_CLIENT_ID: "dev-id",
			YKM_DEV_ACCESS_CLIENT_SECRET: "dev-secret",
			YKM_PROD_ACCESS_CLIENT_ID: "prod-id",
			YKM_PROD_ACCESS_CLIENT_SECRET: "prod-secret",
		};
		expect(resolveTarget(g(), env).headers["CF-Access-Client-Id"]).toBe(
			"dev-id",
		);
		expect(
			resolveTarget(g({ env: "prod" }), env).headers["CF-Access-Client-Id"],
		).toBe("prod-id");
		const devOnly = {
			...token,
			YKM_DEV_ACCESS_CLIENT_ID: "dev-id",
			YKM_DEV_ACCESS_CLIENT_SECRET: "dev-secret",
		};
		expect(
			resolveTarget(g({ env: "prod" }), devOnly).headers["CF-Access-Client-Id"],
		).toBe("id");
	});

	it("環境変数の URL は既定を上書きし、--url はさらに優先する", () => {
		const env = { ...token, YKM_DEV_URL: "https://example.test/" };
		expect(resolveTarget(g(), env).baseUrl).toBe("https://example.test");
		expect(
			resolveTarget(g({ url: "http://localhost:8787" }), env).baseUrl,
		).toBe("http://localhost:8787");
	});

	it("localhost で token が無ければ dev caller ヘッダを送る", () => {
		expect(
			resolveTarget(g({ url: "http://localhost:8787" }), {}).headers,
		).toEqual({ "x-yunomi-dev-caller": "ykm" });
	});

	it("localhost でも token があれば token を使う", () => {
		const t = resolveTarget(g({ url: "http://127.0.0.1:8787" }), token);
		expect(t.headers).not.toHaveProperty("x-yunomi-dev-caller");
	});

	it("リモート宛てで token が無ければ設定エラー", () => {
		expect(() => resolveTarget(g(), {})).toThrow(ConfigError);
		expect(() => resolveTarget(g(), { YKM_ACCESS_CLIENT_ID: "id" })).toThrow(
			ConfigError,
		);
	});

	it("不正な URL は設定エラー", () => {
		expect(() => resolveTarget(g({ url: "not a url" }), token)).toThrow(
			ConfigError,
		);
	});
});
