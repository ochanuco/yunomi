import { err, ok, type Result } from "@yunomi/core";
import * as v from "valibot";

const nonEmpty = v.pipe(v.string(), v.nonEmpty());

const envSchema = v.pipe(
	v.object({
		DISCORD_TOKEN: nonEmpty,
		YUNOMI_URL: v.pipe(v.string(), v.url()),
		CF_ACCESS_CLIENT_ID: v.optional(nonEmpty),
		CF_ACCESS_CLIENT_SECRET: v.optional(nonEmpty),
		YUNOMI_DEV_CALLER: v.optional(v.string()),
		LOG_LEVEL: v.optional(v.picklist(["debug", "info", "warn", "error"])),
	}),
	v.check(
		(e) =>
			Boolean(e.CF_ACCESS_CLIENT_ID) === Boolean(e.CF_ACCESS_CLIENT_SECRET),
		"CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET は両方指定する",
	),
);

export type LogLevel = "debug" | "info" | "warn" | "error";

export type GatewayConfig = {
	discordToken: string;
	yunomiUrl: string;
	access: { clientId: string; clientSecret: string } | null;
	devCaller: boolean;
	logLevel: LogLevel;
};

export const loadConfig = (
	env: Record<string, string | undefined>,
): Result<GatewayConfig, string[]> => {
	// 空文字は未設定として扱う（.env で `KEY=` と書かれがち）
	const cleaned = Object.fromEntries(
		Object.entries(env).filter(([, val]) => val !== undefined && val !== ""),
	);
	const parsed = v.safeParse(envSchema, cleaned);
	if (!parsed.success) {
		return err(
			parsed.issues.map((i) => {
				const path = v.getDotPath(i);
				return path ? `${path}: ${i.message}` : i.message;
			}),
		);
	}
	const e = parsed.output;
	return ok({
		discordToken: e.DISCORD_TOKEN,
		yunomiUrl: e.YUNOMI_URL.replace(/\/+$/, ""),
		access:
			e.CF_ACCESS_CLIENT_ID && e.CF_ACCESS_CLIENT_SECRET
				? {
						clientId: e.CF_ACCESS_CLIENT_ID,
						clientSecret: e.CF_ACCESS_CLIENT_SECRET,
					}
				: null,
		devCaller: e.YUNOMI_DEV_CALLER === "1",
		logLevel: e.LOG_LEVEL ?? "info",
	});
};
