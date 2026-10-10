import { ADMIN_API_PREFIX } from "@yunomi/admin-contract";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import {
	discordSentSchema,
	type GatewayResponse,
	toInboundMessage,
} from "@yunomi/protocol";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { handleAdminApi } from "./admin/api.ts";
import { ADMIN_BASE, serveAdminAsset } from "./admin/static.ts";
import { purgeExpiredAudit } from "./audit-store.ts";
import { authenticate, type Principal } from "./auth/access.ts";
import { PartnerDO } from "./do/partner-do.ts";
import { accessEnv, partnerNamespace } from "./env.ts";

export { PartnerDO };

const DISCORD_EVENTS_PATH = "/v1/interfaces/discord/events";
const DISCORD_SENT_PATH = /^\/v1\/partners\/([^/]+)\/discord\/sent$/;

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "GET" && pathname === "/health") {
			return health(env);
		}
		if (pathname.startsWith(`${ADMIN_API_PREFIX}/`)) {
			return handleAdminApi(request, env);
		}
		if (pathname === "/admin" || pathname.startsWith(ADMIN_BASE)) {
			return serveAdminAsset(request);
		}
		if (pathname === DISCORD_EVENTS_PATH) {
			return discordEvents(request, env);
		}
		const sentPartnerId = DISCORD_SENT_PATH.exec(pathname)?.[1];
		if (sentPartnerId !== undefined) {
			return discordSent(request, env, decodeURIComponent(sentPartnerId));
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

async function discordSent(
	request: Request,
	env: Env,
	partnerId: string,
): Promise<Response> {
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
	if (partnerId !== yukarinProfile.partner_id) {
		return Response.json({ error: "unknown_partner" }, { status: 404 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "invalid_json" }, { status: 400 });
	}
	const parsed = v.safeParse(discordSentSchema, body);
	if (!parsed.success) {
		return Response.json(
			{
				error: "validation_failed",
				message: parsed.issues
					.map((i) => v.getDotPath(i) ?? i.message)
					.join(", "),
			},
			{ status: 400 },
		);
	}

	const partner = partnerNamespace(env);
	const stub = partner.get(partner.idFromName(partnerId));
	return Response.json(await stub.bindSentMessage(parsed.output));
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
