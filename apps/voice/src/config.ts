import {
	DEFAULT_PARTNER_ID,
	err,
	ok,
	PARTNER_IDS,
	type PartnerId,
	type Result,
} from "@yunomi/core";
import * as v from "valibot";

const nonEmpty = v.pipe(v.string(), v.nonEmpty());

const envSchema = v.pipe(
	v.object({
		DISCORD_TOKEN: nonEmpty,
		PARTNER_ID: v.optional(v.picklist(PARTNER_IDS)),
		YUNOMI_URL: v.pipe(v.string(), v.url()),
		CF_ACCESS_CLIENT_ID: v.optional(nonEmpty),
		CF_ACCESS_CLIENT_SECRET: v.optional(nonEmpty),
		OCHOKO_URL: v.optional(v.pipe(v.string(), v.url())),
		AIVOICE_TOKEN: v.optional(nonEmpty),
		KUKICHA_URL: v.optional(v.pipe(v.string(), v.url())),
		KUKICHA_TOKEN: v.optional(nonEmpty),
		YUNOMI_DEV_CALLER: v.optional(v.string()),
		OWNER_DISCORD_USER_ID: v.optional(nonEmpty),
		LOG_LEVEL: v.optional(v.picklist(["debug", "info", "warn", "error"])),
	}),
	v.check(
		(e) =>
			Boolean(e.CF_ACCESS_CLIENT_ID) === Boolean(e.CF_ACCESS_CLIENT_SECRET),
		"CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET は両方指定する",
	),
	v.check(
		(e) => Boolean(e.OCHOKO_URL) === Boolean(e.AIVOICE_TOKEN),
		"OCHOKO_URL と AIVOICE_TOKEN は両方指定する",
	),
	v.check(
		(e) => Boolean(e.KUKICHA_URL) === Boolean(e.KUKICHA_TOKEN),
		"KUKICHA_URL と KUKICHA_TOKEN は両方指定する",
	),
);

export type LogLevel = "debug" | "info" | "warn" | "error";

export type VoiceConfig = {
	/** パートナーの bot の token。relay と同じ bot で Gateway にもう 1 本つなぐ。 */
	discordToken: string;
	partnerId: PartnerId;
	yunomiUrl: string;
	access: { clientId: string; clientSecret: string } | null;
	devCaller: boolean;
	/** 未設定なら声の合成と keep_awake を使わない。 */
	ochoko: { url: string; token: string } | null;
	/** 未設定なら聞いた発話を文字にせず、ログに残すだけにする。 */
	kukicha: { url: string; token: string } | null;
	/** VC でこの人の声だけを聞く。未設定なら耳を閉じて入る。 */
	ownerUserId: string | null;
	logLevel: LogLevel;
};

export const loadConfig = (
	env: Record<string, string | undefined>,
): Result<VoiceConfig, string[]> => {
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
		partnerId: e.PARTNER_ID ?? DEFAULT_PARTNER_ID,
		yunomiUrl: e.YUNOMI_URL.replace(/\/+$/, ""),
		access:
			e.CF_ACCESS_CLIENT_ID && e.CF_ACCESS_CLIENT_SECRET
				? {
						clientId: e.CF_ACCESS_CLIENT_ID,
						clientSecret: e.CF_ACCESS_CLIENT_SECRET,
					}
				: null,
		ochoko:
			e.OCHOKO_URL && e.AIVOICE_TOKEN
				? { url: e.OCHOKO_URL.replace(/\/+$/, ""), token: e.AIVOICE_TOKEN }
				: null,
		kukicha:
			e.KUKICHA_URL && e.KUKICHA_TOKEN
				? { url: e.KUKICHA_URL.replace(/\/+$/, ""), token: e.KUKICHA_TOKEN }
				: null,
		devCaller: e.YUNOMI_DEV_CALLER === "1",
		ownerUserId: e.OWNER_DISCORD_USER_ID ?? null,
		logLevel: e.LOG_LEVEL ?? "info",
	});
};

/** 起動は止めないが、意図しない動きになる設定の組み合わせ。 */
export const configWarnings = (cfg: VoiceConfig): string[] =>
	cfg.kukicha && !cfg.ownerUserId
		? ["KUKICHA_URL is set but OWNER_DISCORD_USER_ID is not; not listening"]
		: [];
