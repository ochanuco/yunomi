import type { AccessEnv } from "./auth/access.ts";
import type { PartnerDO } from "./do/partner-do.ts";

// cloudflare.config.ts の binding は worker を名前で参照するため、DO の型は推論されない。
export const partnerNamespace = (env: Env) =>
	env.PARTNER as DurableObjectNamespace<PartnerDO>;

export const accessEnv = (env: Env): AccessEnv => ({
	YUNOMI_ENV: env.YUNOMI_ENV,
	ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN,
	ACCESS_AUD: env.ACCESS_AUD,
	ACCESS_CALLERS: env.ACCESS_CALLERS as Record<string, string>,
	OWNER_EMAILS: env.OWNER_EMAILS as string[],
});
