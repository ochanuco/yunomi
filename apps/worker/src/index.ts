import { DurableObject } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

export class PartnerDO extends DurableObject<Env> {
	ping(): { ok: true; rows: number } {
		const [row] = this.ctx.storage.sql.exec("SELECT 1 AS one").toArray();
		return { ok: true, rows: Number(row?.one ?? 0) };
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "GET" && pathname === "/health") {
			return health(env);
		}
		return Response.json({ error: "not_found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function health(env: Env): Promise<Response> {
	// 疎通確認用に固定名の DO を使う。パートナーごとの DO は idFromName(partner_id) で引く。
	// cloudflare.config.ts の binding は worker を名前で参照するため、DO の型は推論されない。
	const partner = env.PARTNER as DurableObjectNamespace<PartnerDO>;
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
