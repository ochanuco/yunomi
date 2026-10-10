import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { serveAdminAsset } from "../src/admin/static.ts";

const assets = {
	"/index.html": { type: "text/html; charset=utf-8", body: "<p>admin</p>" },
	"/assets/index-abc.js": {
		type: "text/javascript; charset=utf-8",
		body: "console.log(1)",
	},
};
const req = (path: string, method = "GET") =>
	new Request(`https://yunomi-dev.chanu.co${path}`, { method });

describe("serveAdminAsset", () => {
	it("/admin/ は index.html を no-cache で返す", async () => {
		const res = serveAdminAsset(req("/admin/"), assets);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("cache-control")).toBe("no-cache");
		expect(await res.text()).toBe("<p>admin</p>");
	});

	it("ハッシュ付きの /assets/ は immutable", () => {
		const res = serveAdminAsset(req("/admin/assets/index-abc.js"), assets);
		expect(res.headers.get("cache-control")).toContain("immutable");
	});

	it("/admin は末尾スラッシュ付きへ 308", () => {
		const res = serveAdminAsset(req("/admin"), assets);
		expect(res.status).toBe(308);
		expect(res.headers.get("location")).toBe("/admin/");
	});

	it("存在しないパスや親ディレクトリ参照は 404", () => {
		expect(serveAdminAsset(req("/admin/nope.js"), assets).status).toBe(404);
		expect(serveAdminAsset(req("/admin/constructor"), assets).status).toBe(404);
		expect(serveAdminAsset(req("/admin/%2e%2e/secret"), assets).status).toBe(
			404,
		);
	});

	it("GET / HEAD 以外は 405", () => {
		expect(serveAdminAsset(req("/admin/", "POST"), assets).status).toBe(405);
	});
});

describe("Worker のルーティング", () => {
	it("/admin/api/ は静的配信ではなく API に届く（未認証は 401）", async () => {
		const res = await exports.default.fetch(
			new Request(
				"https://yunomi-dev.chanu.co/admin/api/partners/yukarin/status",
			),
		);
		expect(res.status).toBe(401);
	});

	it("/admin/ は認証なしで返る", async () => {
		const res = await exports.default.fetch(
			new Request("https://yunomi-dev.chanu.co/admin"),
			{ redirect: "manual" },
		);
		expect(res.status).toBe(308);
	});
});
