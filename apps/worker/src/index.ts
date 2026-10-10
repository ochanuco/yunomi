import { yukarinProfile } from "@yunomi/partner-yukarin";
import { type GatewayResponse, toInboundMessage } from "@yunomi/protocol";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { purgeExpiredAudit } from "./audit-store.ts";
import { type AccessEnv, authenticate, type Principal } from "./auth/access.ts";
import { PartnerDO } from "./do/partner-do.ts";

export { PartnerDO };

// cloudflare.config.ts の binding は worker を名前で参照するため、DO の型は推論されない。
const partnerNamespace = (env: Env) =>
	env.PARTNER as DurableObjectNamespace<PartnerDO>;

const DISCORD_EVENTS_PATH = "/v1/interfaces/discord/events";

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "GET" && pathname === "/health") {
			return health(env);
		}
		if (pathname === DISCORD_EVENTS_PATH) {
			return discordEvents(request, env);
		}
		return Response.json({ error: "not_found" }, { status: 404 });
	},

	async scheduled(controller, env): Promise<void> {
		await purgeExpiredAudit(
			drizzle(env.DB),
			new Date(controller.scheduledTime),
		);
	},
} satisfies ExportedHandler<Env>;

const accessEnv = (env: Env): AccessEnv => ({
	YUNOMI_ENV: env.YUNOMI_ENV,
	ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN,
	ACCESS_AUD: env.ACCESS_AUD,
	ACCESS_CALLERS: env.ACCESS_CALLERS as Record<string, string>,
	OWNER_EMAILS: env.OWNER_EMAILS as string[],
});

const isGateway = (p: Principal) =>
	p.kind === "service" && p.caller === "gateway";

async function discordEvents(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ error: "method_not_allowed" }, { status: 405 });
	}
	const auth = await authenticate(request, accessEnv(env));
	if (!auth.ok) {
		return Response.json(
			{ error: auth.failure.error },
			{ status: auth.failure.status },
		);
	}
	if (!isGateway(auth.principal)) {
		return Response.json({ error: "forbidden" }, { status: 403 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "invalid_json" }, { status: 400 });
	}
	const inbound = toInboundMessage(body);
	if (!inbound.ok) {
		return Response.json(
			{ error: "validation_failed", message: inbound.error.message },
			{ status: 400 },
		);
	}
	if (inbound.value.partnerId !== yukarinProfile.partner_id) {
		return Response.json({ error: "unknown_partner" }, { status: 404 });
	}

	const partner = partnerNamespace(env);
	const stub = partner.get(partner.idFromName(inbound.value.partnerId));
	const { audit: _audit, ...response } = await stub.handleDiscordMessage(
		inbound.value,
	);
	return Response.json(response satisfies GatewayResponse);
}

async function health(env: Env): Promise<Response> {
	// 疎通確認用に固定名の DO を使う。パートナーごとの DO は idFromName(partner_id) で引く。
	const partner = partnerNamespace(env);
	const stub = partner.get(partner.idFromName("health"));
	const doResult = await stub.ping();
	const [d1Row] = await drizzle(env.DB).all<{ one: number }>(
		sql`SELECT 1 AS one`,
	);
	return Response.json({
		ok: true,
		env: env.YUNOMI_ENV,
		do: doResult,
		d1: d1Row?.one ?? null,
	});
}
