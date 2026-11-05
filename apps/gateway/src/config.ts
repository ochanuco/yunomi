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
		AVATAR_DIR: v.optional(nonEmpty),
		OWNER_DISCORD_USER_ID: v.optional(nonEmpty),
		WORK_CATEGORY_IDS: v.optional(nonEmpty),
		WORKING_URL: v.optional(v.pipe(v.string(), v.url())),
		WORKING_TOKEN: v.optional(nonEmpty),
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
	v.check(
		(e) => Boolean(e.WORKING_URL) === Boolean(e.WORKING_TOKEN),
		"WORKING_URL と WORKING_TOKEN は両方指定する",
	),
);

export type LogLevel = "debug" | "info" | "warn" | "error";

export type GatewayConfig = {
	discordToken: string;
	/** この gateway の bot が受け持つパートナー。 */
	partnerId: PartnerId;
	yunomiUrl: string;
	access: { clientId: string; clientSecret: string } | null;
	devCaller: boolean;
	/** 未設定なら声の合成と keep_awake を使わない。 */
	ochoko: { url: string; token: string } | null;
	/** 未設定なら聞いた発話を文字にせず、ログに残すだけにする。 */
	kukicha: { url: string; token: string } | null;
	/** 表情画像を置いたディレクトリ。未設定なら同梱の画像を使う。 */
	avatarDir: string | null;
	/** VC でこの人の声だけを聞く。未設定なら耳を閉じて入る。 */
	ownerUserId: string | null;
	/** この Discord カテゴリの発言は Worker に送らず Working へ回す。 */
	workCategoryIds: ReadonlySet<string>;
	/** Working 受付の URL と共有トークン。未設定なら仕事カテゴリの発言は捨てる。 */
	working: { url: string; token: string } | null;
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
		avatarDir: e.AVATAR_DIR ?? null,
		ownerUserId: e.OWNER_DISCORD_USER_ID ?? null,
		workCategoryIds: new Set(
			(e.WORK_CATEGORY_IDS ?? "")
				.split(",")
				.map((id) => id.trim())
				.filter((id) => id !== ""),
		),
		working:
			e.WORKING_URL && e.WORKING_TOKEN
				? { url: e.WORKING_URL, token: e.WORKING_TOKEN }
				: null,
		logLevel: e.LOG_LEVEL ?? "info",
	});
};
