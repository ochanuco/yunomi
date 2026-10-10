import { exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { envelopeBody, inbound } from "./helpers.ts";

const URL_EVENTS = "http://localhost/v1/interfaces/discord/events";
const TEAM = "chanuco.cloudflareaccess.com";
const AUD_DEV =
	"e00c18aa3cabf85ef55c47bd76646b4afa7c763d7cde887085e9a66df1243865";
const GATEWAY_CN = "96068ba533c2ad93dabb8eb2ced3d1c1.access";

let privateKey: CryptoKey;
let jwks: { keys: unknown[] };

beforeAll(async () => {
	const pair = await generateKeyPair("RS256");
	privateKey = pair.privateKey;
	jwks = {
		keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
	};
});

afterEach(() => vi.restoreAllMocks());

const mockCerts = () => {
	const real = globalThis.fetch;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new Request(input as RequestInfo).url;
		if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
			return Response.json(jwks);
		}
		return real(input, init);
	});
};

const token = (claims: Record<string, unknown>) =>
	new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: "k1" })
		.setIssuer(`https://${TEAM}`)
		.setAudience(AUD_DEV)
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(privateKey);

const post = (
	headers: Record<string, string>,
	body: unknown,
	url = URL_EVENTS,
) =>
	exports.default.fetch(
		new Request(url, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		}),
	);

describe("POST /v1/interfaces/discord/events", () => {
	it("gateway の service token で ignore を返し、audit は漏らさない", async () => {
		mockCerts();
		const jwt = await token({ common_name: GATEWAY_CN });
		const res = await post(
			{ "Cf-Access-Jwt-Assertion": jwt },
			envelopeBody(inbound()),
			"https://yunomi-dev.chanu.co/v1/interfaces/discord/events",
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ action: "ignore" });
	});

	it("認証なしは 401", async () => {
		const res = await post({}, envelopeBody(inbound()));
		expect(res.status).toBe(401);
	});

	it("owner の JWT は 403（gateway 専用）", async () => {
		mockCerts();
		const jwt = await token({ email: "teacatus@gmail.com" });
		const res = await post(
			{ "Cf-Access-Jwt-Assertion": jwt },
			envelopeBody(inbound()),
			"https://yunomi-dev.chanu.co/v1/interfaces/discord/events",
		);
		expect(res.status).toBe(403);
	});

	it("ykm は 403", async () => {
		const res = await post(
			{ "x-yunomi-dev-caller": "ykm" },
			envelopeBody(inbound()),
		);
		expect(res.status).toBe(403);
	});

	it("dev bypass は localhost のときだけ", async () => {
		const ok = await post(
			{ "x-yunomi-dev-caller": "gateway" },
			envelopeBody(inbound()),
		);
		expect(ok.status).toBe(200);
		const viaDomain = await post(
			{ "x-yunomi-dev-caller": "gateway" },
			envelopeBody(inbound()),
			"https://yunomi-dev.chanu.co/v1/interfaces/discord/events",
		);
		expect(viaDomain.status).toBe(401);
	});

	it("不正な body は 400", async () => {
		const res = await post({ "x-yunomi-dev-caller": "gateway" }, { nope: 1 });
		expect(res.status).toBe(400);
	});

	it("未知の partner は 404", async () => {
		const res = await post(
			{ "x-yunomi-dev-caller": "gateway" },
			envelopeBody(inbound({ partnerId: "other" })),
		);
		expect(res.status).toBe(404);
	});

	it("/health は認証不要", async () => {
		const res = await exports.default.fetch(
			new Request("https://yunomi-dev.chanu.co/health"),
		);
		expect(res.status).toBe(200);
	});
});
