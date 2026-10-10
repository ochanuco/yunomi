import type { Global } from "./args.ts";

export const DEFAULT_URLS = {
	dev: "https://yunomi-dev.chanu.co",
	prod: "https://yunomi.chanu.co",
} as const;

export type Target = { baseUrl: string; headers: Record<string, string> };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class ConfigError extends Error {}

export const resolveTarget = (
	global: Global,
	env: Record<string, string | undefined>,
): Target => {
	const configured = global.env === "dev" ? env.YKM_DEV_URL : env.YKM_PROD_URL;
	const raw = global.url ?? (configured || DEFAULT_URLS[global.env]);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ConfigError(`接続先 URL が不正: ${raw}`);
	}

	const id = env.YKM_ACCESS_CLIENT_ID;
	const secret = env.YKM_ACCESS_CLIENT_SECRET;
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
