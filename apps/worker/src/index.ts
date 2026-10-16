import { ADMIN_API_PREFIX } from "@yunomi/admin-contract";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import {
	DISCORD_VOICE_EVENTS_PATH,
	discordSentSchema,
	discordVoiceConnectionSchema,
	type GatewayResponse,
	toInboundMessage,
	toVoiceStateUpdate,
	type VoiceResponse,
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
import { aggregateDailyKpis } from "./kpi-store.ts";
import { createSnapshot } from "./snapshot.ts";
import { purgeExpiredSnapshots } from "./snapshot-store.ts";

export { PartnerDO };

const DISCORD_EVENTS_PATH = "/v1/interfaces/discord/events";
const DISCORD_SENT_PATH = /^\/v1\/partners\/([^/]+)\/discord\/sent$/;
const DISCORD_VOICE_CONNECTION_PATH =
	/^\/v1\/partners\/([^/]+)\/discord\/voice-connection$/;

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
		if (pathname === DISCORD_VOICE_EVENTS_PATH) {
			return discordVoiceEvents(request, env);
		}
		const connectionPartnerId =
			DISCORD_VOICE_CONNECTION_PATH.exec(pathname)?.[1];
		if (connectionPartnerId !== undefined) {
			return discordVoiceConnection(
				request,
				env,
				decodeURIComponent(connectionPartnerId),
			);
		}
		const sentPartnerId = DISCORD_SENT_PATH.exec(pathname)?.[1];
		if (sentPartnerId !== undefined) {
			return discordSent(request, env, decodeURIComponent(sentPartnerId));
		}
		return Response.json({ error: "not_found" }, { status: 404 });
	},

	async scheduled(controller, env): Promise<void> {
		const db = drizzle(env.DB);
		const now = new Date(controller.scheduledTime);
		// Snapshot の失敗で KPI 集計と audit 削除を止めない。audit が先に消えても Snapshot は影響を受けない。
		await snapshotDaily(env, now);
		// 集計に失敗したら削除しない。削除済みの行は再集計できない。
		await aggregateDailyKpis(
			db,
			now,
			yukarinProfile.living_rhythm.lifestyle_day_boundary,
		);
		await purgeExpiredAudit(db, now);
	},
} satisfies ExportedHandler<Env>;

const snapshotDaily = async (env: Env, now: Date): Promise<void> => {
	const partnerId = yukarinProfile.partner_id;
	try {
		const partner = partnerNamespace(env);
		const created = await createSnapshot({
			db: env.DB,
			partner: partner.get(partner.idFromName(partnerId)),
			partnerId,
			env: env.YUNOMI_ENV,
			now,
			bucket: env.SNAPSHOTS,
			recipient: env.SNAPSHOT_AGE_RECIPIENT,
		});
		if (!created.ok) console.error("snapshot create failed", created.error);
	} catch (e) {
		console.error("snapshot create failed", e);
	}
	try {
		await purgeExpiredSnapshots(env.SNAPSHOTS, partnerId, now);
	} catch (e) {
		console.error("snapshot purge failed", e);
	}
};

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

// Gateway からの POST を受ける経路の共通部分: メソッド・認証・caller・JSON 本文。
async function readGatewayJson(
	request: Request,
	env: Env,
): Promise<{ body: unknown } | { response: Response }> {
	if (request.method !== "POST") {
		return {
			response: Response.json({ error: "method_not_allowed" }, { status: 405 }),
		};
	}
	const auth = await authenticate(request, accessEnv(env));
	if (!auth.ok) {
		return {
			response: Response.json(
				{ error: auth.failure.error },
				{ status: auth.failure.status },
			),
		};
	}
	if (!isGateway(auth.principal)) {
		return {
			response: Response.json({ error: "forbidden" }, { status: 403 }),
		};
	}
	try {
		return { body: await request.json() };
	} catch {
		return {
			response: Response.json({ error: "invalid_json" }, { status: 400 }),
		};
	}
}

async function discordVoiceEvents(
	request: Request,
	env: Env,
): Promise<Response> {
	const read = await readGatewayJson(request, env);
	if ("response" in read) return read.response;
	const update = toVoiceStateUpdate(read.body);
	if (!update.ok) {
		return Response.json(
			{ error: "validation_failed", message: update.error.message },
			{ status: 400 },
		);
	}
	if (update.value.partnerId !== yukarinProfile.partner_id) {
		return Response.json({ error: "unknown_partner" }, { status: 404 });
	}
	const partner = partnerNamespace(env);
	const stub = partner.get(partner.idFromName(update.value.partnerId));
	const response = await stub.handleVoiceState(update.value);
	return Response.json(response satisfies VoiceResponse);
}

async function discordVoiceConnection(
	request: Request,
	env: Env,
	partnerId: string,
): Promise<Response> {
	const read = await readGatewayJson(request, env);
	if ("response" in read) return read.response;
	if (partnerId !== yukarinProfile.partner_id) {
		return Response.json({ error: "unknown_partner" }, { status: 404 });
	}
	const parsed = v.safeParse(discordVoiceConnectionSchema, read.body);
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
	return Response.json(await stub.reportVoiceConnection(parsed.output));
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
