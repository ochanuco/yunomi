import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { type AccessEnv, authenticate } from "../src/auth/access.ts";

const TEAM = "team.example.com";
const AUD = "aud-1";
const accessEnv: AccessEnv = {
	YUNOMI_ENV: "production",
	ACCESS_TEAM_DOMAIN: TEAM,
	ACCESS_AUD: AUD,
	ACCESS_CALLERS: { "gw.access": "gateway", "ykm.access": "ykm" },
	OWNER_EMAILS: ["Owner@example.com"],
};

let privateKey: CryptoKey;
let otherKey: CryptoKey;
let keys: () => Promise<CryptoKey>;

beforeAll(async () => {
	const pair = await generateKeyPair("RS256");
	privateKey = pair.privateKey;
	otherKey = (await generateKeyPair("RS256")).privateKey;
	keys = async () => pair.publicKey;
});

const sign = (
	claims: Record<string, unknown>,
	opts: { key?: CryptoKey; aud?: string; iss?: string; exp?: string } = {},
) =>
	new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "k1" })
		.setIssuer(opts.iss ?? `https://${TEAM}`)
		.setAudience(opts.aud ?? AUD)
		.setIssuedAt()
		.setExpirationTime(opts.exp ?? "5m")
		.sign(opts.key ?? privateKey);

const req = (
	headers: Record<string, string>,
	url = "https://yunomi.example/x",
) => new Request(url, { headers });

describe("authenticate", () => {
	it("owner の email を許可リスト（大文字小文字無視）で通す", async () => {
		const token = await sign({ email: "owner@example.com" });
		const r = await authenticate(
			req({ "Cf-Access-Jwt-Assertion": token }),
			accessEnv,
			keys,
		);
		expect(r).toEqual({
			ok: true,
			principal: { kind: "owner", email: "owner@example.com" },
		});
	});

	it("許可外の email は 403", async () => {
		const token = await sign({ email: "x@example.com" });
		const r = await authenticate(
			req({ "Cf-Access-Jwt-Assertion": token }),
			accessEnv,
			keys,
		);
		expect(r).toMatchObject({ ok: false, failure: { status: 403 } });
	});

	it("service token は common_name から呼び出し元を引く", async () => {
		const token = await sign({ common_name: "gw.access" });
		const r = await authenticate(
			req({ "Cf-Access-Jwt-Assertion": token }),
			accessEnv,
			keys,
		);
		expect(r).toEqual({
			ok: true,
			principal: { kind: "service", caller: "gateway" },
		});
	});

	it("未登録の common_name は 403", async () => {
		const token = await sign({ common_name: "nope.access" });
		const r = await authenticate(
			req({ "Cf-Access-Jwt-Assertion": token }),
			accessEnv,
			keys,
		);
		expect(r).toMatchObject({ ok: false, failure: { status: 403 } });
	});

	it("トークンなしは 401", async () => {
		const r = await authenticate(req({}), accessEnv, keys);
		expect(r).toMatchObject({ ok: false, failure: { status: 401 } });
	});

	it.each([
		["別の鍵で署名", { other: true }],
		["aud 不一致", { aud: "other-aud" }],
		["issuer 不一致", { iss: "https://evil.example.com" }],
		["期限切れ", { exp: "-1m" }],
	])("%s は 401", async (_name, o) => {
		const { other, ...opts } = { other: false, ...o };
		const token = await sign(
			{ common_name: "gw.access" },
			{ ...opts, key: other ? otherKey : undefined },
		);
		const r = await authenticate(
			req({ "Cf-Access-Jwt-Assertion": token }),
			accessEnv,
			keys,
		);
		expect(r).toMatchObject({ ok: false, failure: { status: 401 } });
	});

	describe("dev bypass", () => {
		const dev = { ...accessEnv, YUNOMI_ENV: "development" };
		const header = { "x-yunomi-dev-caller": "gateway" };

		it("development かつ localhost のときだけ通る", async () => {
			const r = await authenticate(
				req(header, "http://localhost:8787/x"),
				dev,
				keys,
			);
			expect(r).toEqual({
				ok: true,
				principal: { kind: "service", caller: "gateway" },
			});
		});

		it("カスタムドメイン宛ては通らない", async () => {
			const r = await authenticate(
				req(header, "https://yunomi-dev.chanu.co/x"),
				dev,
				keys,
			);
			expect(r).toMatchObject({ ok: false, failure: { status: 401 } });
		});

		it("production では localhost でも通らない", async () => {
			const r = await authenticate(
				req(header, "http://localhost:8787/x"),
				accessEnv,
				keys,
			);
			expect(r).toMatchObject({ ok: false, failure: { status: 401 } });
		});
	});
});
