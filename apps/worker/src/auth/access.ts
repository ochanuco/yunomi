import {
	createRemoteJWKSet,
	errors,
	type JWTPayload,
	type JWTVerifyGetKey,
	jwtVerify,
} from "jose";

export type Caller = "gateway" | "ykm";

export type Principal =
	| { kind: "owner"; email: string }
	| { kind: "service"; caller: Caller };

export type AuthFailure = { status: 401 | 403; error: string };

export type AccessEnv = {
	YUNOMI_ENV: string;
	ALLOW_DEV_CALLER: string;
	ACCESS_TEAM_DOMAIN: string;
	ACCESS_AUD: string;
	ACCESS_CALLERS: Record<string, string>;
	OWNER_EMAILS: string[];
};

export const DEV_CALLER_HEADER = "x-yunomi-dev-caller";

// isolate 内で JWKS を使い回す（jose が取得結果と cooldown を管理する）。
const remoteKeys = new Map<string, JWTVerifyGetKey>();

export const accessKeySource = (teamDomain: string): JWTVerifyGetKey => {
	let keys = remoteKeys.get(teamDomain);
	if (!keys) {
		keys = createRemoteJWKSet(
			new URL(`https://${teamDomain}/cdn-cgi/access/certs`),
		);
		remoteKeys.set(teamDomain, keys);
	}
	return keys;
};

const isCaller = (v: string): v is Caller => v === "gateway" || v === "ykm";

const fail = (status: 401 | 403, error: string) => ({
	ok: false as const,
	failure: { status, error } satisfies AuthFailure,
});

export type AuthResult =
	| { ok: true; principal: Principal }
	| { ok: false; failure: AuthFailure };

/**
 * ローカル開発用の迂回。`ALLOW_DEV_CALLER=1`（cf の local mode だけが設定する）のときだけ
 * `x-yunomi-dev-caller` を信用する。cf dev はカスタムドメイン設定時に request.url を書き換えるため、
 * host では判定しない。
 */
const devBypass = (request: Request, env: AccessEnv): Caller | null => {
	if (env.ALLOW_DEV_CALLER !== "1") return null;
	const caller = request.headers.get(DEV_CALLER_HEADER);
	return caller && isCaller(caller) ? caller : null;
};

export const authenticate = async (
	request: Request,
	env: AccessEnv,
	keys: JWTVerifyGetKey = accessKeySource(env.ACCESS_TEAM_DOMAIN),
): Promise<AuthResult> => {
	const dev = devBypass(request, env);
	if (dev) return { ok: true, principal: { kind: "service", caller: dev } };

	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) return fail(401, "missing_token");

	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(token, keys, {
			algorithms: ["RS256"],
			issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
			audience: env.ACCESS_AUD,
		}));
	} catch (e) {
		// JWKS 取得失敗は検証不能であり、認証失敗として扱う。
		return fail(401, e instanceof errors.JOSEError ? e.code : "invalid_token");
	}

	if (typeof payload.email === "string" && payload.email) {
		const email = payload.email.toLowerCase();
		const allowed = env.OWNER_EMAILS.some((o) => o.toLowerCase() === email);
		return allowed
			? { ok: true, principal: { kind: "owner", email } }
			: fail(403, "not_owner");
	}

	const commonName = payload.common_name;
	if (typeof commonName === "string") {
		const caller = env.ACCESS_CALLERS[commonName];
		if (caller && isCaller(caller)) {
			return { ok: true, principal: { kind: "service", caller } };
		}
	}
	return fail(403, "unknown_caller");
};
