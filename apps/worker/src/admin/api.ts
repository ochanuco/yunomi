import {
	ADMIN_API_PREFIX,
	type AuditResponse,
	type InterestsResponse,
	type KpisResponse,
	type MemoryResponse,
	type OpenLoopsResponse,
	type OpinionsResponse,
	type RelationshipsResponse,
	type StatusResponse,
} from "@yunomi/admin-contract";
import { yukarinProfile } from "@yunomi/partner-yukarin";
import { drizzle } from "drizzle-orm/d1";
import { authenticate } from "../auth/access.ts";
import { accessEnv, partnerNamespace } from "../env.ts";
import { createInterestOpinionRepo } from "../interest-opinion.ts";
import { KPI_DEFAULT_DAYS, KPI_MAX_DAYS, readDailyKpis } from "../kpi-store.ts";
import { decodeCursor } from "./cursor.ts";
import { createAdminQueries } from "./queries.ts";

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, error: string) => json({ error }, status);

const ROUTE = new RegExp(
	`^${ADMIN_API_PREFIX}/partners/([^/]+)/(status|relationships|memory|open-loops|interests|opinions|audit|kpis)$`,
);

type Params = { limit: number; cursor: ReturnType<typeof decodeCursor> };

const parsePage = (url: URL): Params | Response => {
	const rawLimit = url.searchParams.get("limit");
	let limit = DEFAULT_PAGE_LIMIT;
	if (rawLimit !== null) {
		limit = Number(rawLimit);
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
			return fail(400, "invalid_limit");
		}
	}
	const rawCursor = url.searchParams.get("cursor");
	if (rawCursor === null) return { limit, cursor: null };
	const cursor = decodeCursor(rawCursor);
	return cursor ? { limit, cursor } : fail(400, "invalid_cursor");
};

/** 読み取り専用。owner（Access の email）と service caller `ykm` だけが使える。 */
export async function handleAdminApi(
	request: Request,
	env: Env,
): Promise<Response> {
	const auth = await authenticate(request, accessEnv(env));
	if (!auth.ok) return fail(auth.failure.status, auth.failure.error);
	const { principal } = auth;
	if (principal.kind === "service" && principal.caller !== "ykm") {
		return fail(403, "forbidden");
	}

	const url = new URL(request.url);
	const match = ROUTE.exec(url.pathname);
	if (!match) return fail(404, "not_found");
	if (request.method !== "GET") return fail(405, "method_not_allowed");

	const partnerId = decodeURIComponent(match[1] ?? "");
	if (partnerId !== yukarinProfile.partner_id) {
		return fail(404, "unknown_partner");
	}

	const queries = createAdminQueries(drizzle(env.DB));
	const partner = partnerNamespace(env);
	const stub = () => partner.get(partner.idFromName(partnerId));

	switch (match[2]) {
		case "status": {
			const [state, counts, lastAuditAt] = await Promise.all([
				stub().adminState(),
				queries.counts(partnerId),
				queries.lastAuditAt(partnerId),
			]);
			return json({
				partner_id: partnerId,
				env: env.YUNOMI_ENV,
				profile_version: yukarinProfile.schema_version,
				state: state && {
					mood: state.mood,
					energy: state.energy,
					presence: state.presence,
					system_stress: state.systemStress,
					degraded_mode: state.degradedMode,
					version: state.version,
					updated_at: state.updatedAt,
				},
				counts: {
					facts: counts.facts,
					pending_candidates: counts.pendingCandidates,
				},
				last_audit_at: lastAuditAt,
			} satisfies StatusResponse);
		}
		case "relationships": {
			const items = await queries.relationshipViews(
				await stub().adminRelationships(),
			);
			return json({ items } satisfies RelationshipsResponse);
		}
		case "memory": {
			const kind = url.searchParams.get("kind") ?? "facts";
			if (kind !== "facts" && kind !== "candidates") {
				return fail(400, "invalid_kind");
			}
			const page = parsePage(url);
			if (page instanceof Response) return page;
			const include = url.searchParams.get("include");
			if (include !== null && include !== "all") {
				return fail(400, "invalid_include");
			}
			if (kind === "facts") {
				const r = await queries.facts(
					partnerId,
					page.limit,
					page.cursor,
					include === "all" ? null : { now: new Date() },
				);
				return json({
					kind,
					items: r.items,
					next_cursor: r.nextCursor,
				} satisfies MemoryResponse);
			}
			const r = await queries.candidates(partnerId, page.limit, page.cursor);
			return json({
				kind,
				items: r.items,
				next_cursor: r.nextCursor,
			} satisfies MemoryResponse);
		}
		case "open-loops": {
			const status = url.searchParams.get("status") ?? "open";
			if (status !== "open" && status !== "all") {
				return fail(400, "invalid_status");
			}
			const page = parsePage(url);
			if (page instanceof Response) return page;
			const r = await queries.openLoops(
				partnerId,
				page.limit,
				page.cursor,
				status === "open",
			);
			return json({
				items: r.items,
				next_cursor: r.nextCursor,
			} satisfies OpenLoopsResponse);
		}
		case "interests": {
			const { interests } = await createInterestOpinionRepo(
				drizzle(env.DB),
			).current(yukarinProfile);
			const items = interests
				.map((i) => ({
					topic: i.topic,
					label: i.label,
					score: i.score,
					baseline: i.baseline,
					learned_delta: i.learnedDelta,
					summary: i.summary,
					updated_at: i.updatedAt,
					source: i.source,
				}))
				.sort((a, b) => b.score - a.score);
			return json({ items } satisfies InterestsResponse);
		}
		case "opinions": {
			const { opinions } = await createInterestOpinionRepo(
				drizzle(env.DB),
			).current(yukarinProfile);
			const items = opinions.map((o) => ({
				topic: o.topic,
				label: o.label,
				stance: o.stance,
				confidence: o.confidence,
				stability: o.stability,
				reasons: o.reasons,
				source_memory_ids: o.sourceMemoryIds,
				updated_at: o.updatedAt,
				source: o.source,
			}));
			return json({ items } satisfies OpinionsResponse);
		}
		case "kpis": {
			const rawDays = url.searchParams.get("days");
			let days = KPI_DEFAULT_DAYS;
			if (rawDays !== null) {
				days = Number(rawDays);
				if (!Number.isInteger(days) || days < 1 || days > KPI_MAX_DAYS) {
					return fail(400, "invalid_days");
				}
			}
			const items = await readDailyKpis(
				drizzle(env.DB),
				partnerId,
				days,
				new Date(),
				yukarinProfile.living_rhythm.lifestyle_day_boundary,
			);
			return json({ items } satisfies KpisResponse);
		}
		default: {
			const page = parsePage(url);
			if (page instanceof Response) return page;
			const rawSince = url.searchParams.get("since");
			let since: string | null = null;
			if (rawSince !== null) {
				const t = Date.parse(rawSince);
				if (Number.isNaN(t)) return fail(400, "invalid_since");
				since = new Date(t).toISOString();
			}
			const r = await queries.audit(partnerId, page.limit, page.cursor, since);
			return json({
				items: r.items,
				next_cursor: r.nextCursor,
			} satisfies AuditResponse);
		}
	}
}
