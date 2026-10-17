import {
	ADMIN_API_PREFIX,
	ApiErrorSchema,
	type AuditResponse,
	AuditResponseSchema,
	type MemoryKind,
	type MemoryResponse,
	MemoryResponseSchema,
	type RelationshipsResponse,
	RelationshipsResponseSchema,
	type StateHistoryResponse,
	StateHistoryResponseSchema,
	type StatusResponse,
	StatusResponseSchema,
} from "@yunomi/admin-contract";
import * as v from "valibot";

export class ApiError extends Error {}

export type Api = {
	status(): Promise<StatusResponse>;
	relationships(): Promise<RelationshipsResponse>;
	stateHistory(days: number): Promise<StateHistoryResponse>;
	memory(q: {
		kind: MemoryKind;
		limit: number;
		cursor?: string;
	}): Promise<MemoryResponse>;
	audit(q: { limit: number; cursor?: string }): Promise<AuditResponse>;
};

export const PARTNER_ID = "yukarin";

export const createApi = (
	fetchImpl: typeof fetch = (input, init) => fetch(input, init),
	partner = PARTNER_ID,
): Api => {
	const call = async <T extends v.GenericSchema>(
		path: string,
		schema: T,
		query: Record<string, string | number | undefined> = {},
	): Promise<v.InferOutput<T>> => {
		const params = new URLSearchParams();
		for (const [k, val] of Object.entries(query)) {
			if (val !== undefined) params.set(k, String(val));
		}
		const qs = params.size > 0 ? `?${params}` : "";
		let res: Response;
		try {
			res = await fetchImpl(
				`${ADMIN_API_PREFIX}/partners/${encodeURIComponent(partner)}/${path}${qs}`,
				{ credentials: "same-origin", redirect: "manual" },
			);
		} catch {
			throw new ApiError("サーバーに接続できない");
		}
		// Access のセッション切れはログインページへのリダイレクトになる。
		if (res.type === "opaqueredirect" || res.status === 0) {
			throw new ApiError("セッションが切れた。ページを再読み込みする");
		}
		const body: unknown = await res.json().catch(() => null);
		if (!res.ok) {
			const parsed = v.safeParse(ApiErrorSchema, body);
			throw new ApiError(
				`HTTP ${res.status}${parsed.success ? ` ${parsed.output.error}` : ""}`,
			);
		}
		const parsed = v.safeParse(schema, body);
		if (!parsed.success) throw new ApiError("応答の形が想定と違う");
		return parsed.output;
	};

	return {
		status: () => call("status", StatusResponseSchema),
		relationships: () => call("relationships", RelationshipsResponseSchema),
		stateHistory: (days) =>
			call("state-history", StateHistoryResponseSchema, { days }),
		memory: (q) => call("memory", MemoryResponseSchema, q),
		audit: (q) => call("audit", AuditResponseSchema, q),
	};
};
