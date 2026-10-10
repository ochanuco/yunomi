import {
	ADMIN_API_PREFIX,
	ApiErrorSchema,
	type AuditResponse,
	AuditResponseSchema,
	type KpisResponse,
	KpisResponseSchema,
	type MemoryInclude,
	type MemoryKind,
	type MemoryResponse,
	MemoryResponseSchema,
	type RelationshipsResponse,
	RelationshipsResponseSchema,
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
	kpis(q: { days: number }): Promise<KpisResponse>;
	audit(q: {
		limit: number;
		cursor?: string;
		since?: string;
	}): Promise<AuditResponse>;
};

export const createClient = (
	target: Target,
	partner: string,
	fetchImpl: Fetch = fetch,
): AdminClient => {
	const call = async <T extends v.GenericSchema>(
		path: string,
		schema: T,
		query: Record<string, string | number | undefined> = {},
	): Promise<v.InferOutput<T>> => {
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
				headers: { accept: "application/json", ...target.headers },
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
		const body: unknown = await res.json().catch(() => null);
		if (!res.ok) {
			const parsed = v.safeParse(ApiErrorSchema, body);
			throw new ApiError(
				`HTTP ${res.status}${parsed.success ? ` ${parsed.output.error}` : ""}`,
			);
		}
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
		kpis: (q) => call("kpis", KpisResponseSchema, q),
		audit: (q) => call("audit", AuditResponseSchema, q),
	};
};
