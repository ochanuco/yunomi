import type { Global } from "./args.ts";

export type Target = { baseUrl: string; headers: Record<string, string> };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ConfigError extends Error {}

export const resolveTarget = (
	global: Global,
	env: Record<string, string | undefined>,
): Target => {
	const urlVar = global.env === "dev" ? "YKM_DEV_URL" : "YKM_PROD_URL";
	const raw = global.url ?? env[urlVar];
	if (!raw) {
		throw new ConfigError(`接続先を ${urlVar} か --url で指定する`);
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ConfigError(`接続先 URL が不正: ${raw}`);
	}

	// dev と prod は別の Access service token を使うため、env 別の指定を優先する。seed は両方に接続する。
	const prefix = global.env === "dev" ? "YKM_DEV" : "YKM_PROD";
	const id = env[`${prefix}_ACCESS_CLIENT_ID`] || env.YKM_ACCESS_CLIENT_ID;
	const secret =
		env[`${prefix}_ACCESS_CLIENT_SECRET`] || env.YKM_ACCESS_CLIENT_SECRET;
	const headers: Record<string, string> = {};
	if (id && secret) {
		headers["CF-Access-Client-Id"] = id;
		headers["CF-Access-Client-Secret"] = secret;
	} else if (LOCAL_HOSTS.has(url.hostname)) {
		headers["x-yunomi-dev-caller"] = "ykm";
	} else {
		throw new ConfigError(
			"YKM_ACCESS_CLIENT_ID と YKM_ACCESS_CLIENT_SECRET を設定する（localhost 宛てのときは不要）",
		);
	}
	return { baseUrl: url.origin, headers };
};
