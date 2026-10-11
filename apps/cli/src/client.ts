import {
	ADMIN_API_PREFIX,
	ApiErrorSchema,
	type AuditResponse,
	AuditResponseSchema,
	type InterestsResponse,
	InterestsResponseSchema,
	type KpisResponse,
	KpisResponseSchema,
	type MemoryInclude,
	type MemoryKind,
	type MemoryResponse,
	MemoryResponseSchema,
	type OpenLoopsFilter,
	type OpenLoopsResponse,
	OpenLoopsResponseSchema,
	type OpinionsResponse,
	OpinionsResponseSchema,
	type RelationshipsResponse,
	RelationshipsResponseSchema,
	type Snapshot,
	type SnapshotRestoreResponse,
	SnapshotRestoreResponseSchema,
	type SnapshotSummary,
	SnapshotSummarySchema,
	type SnapshotsResponse,
	SnapshotsResponseSchema,
	type StatusResponse,
	StatusResponseSchema,
} from "@yunomi/admin-contract";
import * as v from "valibot";
import type { Target } from "./config.ts";

export class ApiError extends Error {}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type AdminClient = {
	status(): Promise<StatusResponse>;
	relationships(): Promise<RelationshipsResponse>;
	memory(q: {
		kind: MemoryKind;
		limit: number;
		cursor?: string;
		include?: MemoryInclude;
	}): Promise<MemoryResponse>;
	openLoops(q: {
		status?: OpenLoopsFilter;
		limit: number;
		cursor?: string;
	}): Promise<OpenLoopsResponse>;
	interests(): Promise<InterestsResponse>;
	opinions(): Promise<OpinionsResponse>;
	kpis(q: { days: number }): Promise<KpisResponse>;
	audit(q: {
		limit: number;
		cursor?: string;
		since?: string;
	}): Promise<AuditResponse>;
	snapshots(): Promise<SnapshotsResponse>;
	createSnapshot(): Promise<SnapshotSummary>;
	/** 暗号化されたまま取得する。 */
	downloadSnapshot(id: string): Promise<Uint8Array>;
	restoreSnapshot(snapshot: Snapshot): Promise<SnapshotRestoreResponse>;
};

export const createClient = (
	target: Target,
	partner: string,
	fetchImpl: Fetch = fetch,
): AdminClient => {
	const send = async (
		path: string,
		init: { method?: string; body?: string; accept?: string } = {},
		query: Record<string, string | number | undefined> = {},
	): Promise<Response> => {
		const url = new URL(
			`${ADMIN_API_PREFIX}/partners/${encodeURIComponent(partner)}/${path}`,
			target.baseUrl,
		);
		for (const [k, val] of Object.entries(query)) {
			if (val !== undefined) url.searchParams.set(k, String(val));
		}
		let res: Response;
		try {
			res = await fetchImpl(url.toString(), {
				method: init.method ?? "GET",
				body: init.body,
				headers: {
					accept: init.accept ?? "application/json",
					...(init.body === undefined
						? {}
						: { "content-type": "application/json" }),
					...target.headers,
				},
				redirect: "manual",
			});
		} catch (e) {
			throw new ApiError(
				`${target.baseUrl} に接続できない: ${e instanceof Error ? e.message : e}`,
			);
		}
		// Access 未認証はログインページへの 3xx になる。
		if (res.status >= 300 && res.status < 400) {
			throw new ApiError(
				`認証されていない（リダイレクトされた）。Access service token を確認する: HTTP ${res.status}`,
			);
		}
		if (!res.ok) {
			const body: unknown = await res.json().catch(() => null);
			const parsed = v.safeParse(ApiErrorSchema, body);
			throw new ApiError(
				`HTTP ${res.status}${parsed.success ? ` ${parsed.output.error}` : ""}`,
			);
		}
		return res;
	};

	const call = async <T extends v.GenericSchema>(
		path: string,
		schema: T,
		query: Record<string, string | number | undefined> = {},
		init: { method?: string; body?: string } = {},
	): Promise<v.InferOutput<T>> => {
		const res = await send(path, init, query);
		const body: unknown = await res.json().catch(() => null);
		const parsed = v.safeParse(schema, body);
		if (!parsed.success) {
			throw new ApiError(
				`応答が admin-contract と一致しない: ${parsed.issues[0]?.message ?? ""}`,
			);
		}
		return parsed.output;
	};

	return {
		status: () => call("status", StatusResponseSchema),
		relationships: () => call("relationships", RelationshipsResponseSchema),
		memory: (q) => call("memory", MemoryResponseSchema, q),
		openLoops: (q) => call("open-loops", OpenLoopsResponseSchema, q),
		interests: () => call("interests", InterestsResponseSchema),
		opinions: () => call("opinions", OpinionsResponseSchema),
		kpis: (q) => call("kpis", KpisResponseSchema, q),
		audit: (q) => call("audit", AuditResponseSchema, q),
		snapshots: () => call("snapshots", SnapshotsResponseSchema),
		createSnapshot: () =>
			call("snapshots", SnapshotSummarySchema, {}, { method: "POST" }),
		downloadSnapshot: async (id) =>
			new Uint8Array(
				await (
					await send(`snapshots/${encodeURIComponent(id)}`, {
						accept: "application/octet-stream",
					})
				).arrayBuffer(),
			),
		restoreSnapshot: (snapshot) =>
			call(
				"snapshots/restore",
				SnapshotRestoreResponseSchema,
				{},
				{ method: "POST", body: JSON.stringify(snapshot) },
			),
	};
};
