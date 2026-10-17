import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
	rateLimited,
	validationFailed,
} from "@yunomi/core";
import * as v from "valibot";
import type { CapabilityAdapter, CapabilityResponse } from "../contract.ts";
import { type PlaceSearchInput, placeSearch } from "../definitions/place.ts";
import { parseToolInput } from "../input.ts";

const SERVICE = "google_places";
const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
	"places.id",
	"places.displayName",
	"places.formattedAddress",
	"places.businessStatus",
	"places.currentOpeningHours",
].join(",");
const MAX_PLACES = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type GooglePlacesDeps = {
	fetch: typeof fetch;
	apiKey: string;
	/** Places API への fetch の待ち時間の上限（ms）。既定は 10 秒。 */
	timeoutMs?: number;
};

const SearchResponse = v.object({
	places: v.optional(
		v.array(
			v.object({
				displayName: v.optional(v.object({ text: v.optional(v.string()) })),
				formattedAddress: v.optional(v.string()),
				businessStatus: v.optional(v.string()),
				currentOpeningHours: v.optional(
					v.object({
						openNow: v.optional(v.boolean()),
						weekdayDescriptions: v.optional(v.array(v.string())),
					}),
				),
			}),
		),
		[],
	),
});

// externalServiceUnavailable は retryable: true で作られる。直らない失敗は retryable を下げる。
const unavailable = (detail: string, retryable = true): DomainError => {
	const base = externalServiceUnavailable({ service: SERVICE });
	return { ...base, retryable, message: `${base.message}: ${detail}` };
};

// weekdayDescriptions は月曜が先頭。JST の日付で今日の曜日を決める。
const todayHours = (
	descriptions: readonly string[] | undefined,
	now: Date,
): string | null => {
	const sundayFirst = new Date(now.getTime() + JST_OFFSET_MS).getUTCDay();
	return descriptions?.[(sundayFirst + 6) % 7] ?? null;
};

/**
 * Google Places API (New) の Text Search の adapter。読み取りだけで、状態を持たない。
 * Google の規約で place_id 以外の保存が制限されるので、summary に場所の情報を入れない。
 */
export const createGooglePlacesAdapter = (
	deps: GooglePlacesDeps,
): CapabilityAdapter => {
	// Workers の fetch は this が globalThis でないと Illegal invocation になるため、プロパティ越しに呼ばない。
	const doFetch = deps.fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const search = async (
		input: PlaceSearchInput,
		now: Date,
	): Promise<Result<CapabilityResponse, DomainError>> => {
		let res: Response;
		try {
			res = await doFetch(SEARCH_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Goog-Api-Key": deps.apiKey,
					"X-Goog-FieldMask": FIELD_MASK,
				},
				body: JSON.stringify({
					textQuery: input.query,
					languageCode: "ja",
					regionCode: "JP",
					pageSize: MAX_PLACES,
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (e) {
			const timedOut = e instanceof Error && e.name === "TimeoutError";
			return err(
				unavailable(
					timedOut
						? "Places API の応答がタイムアウトした"
						: "Places API に接続できない",
				),
			);
		}
		if (res.status === 429) return err(rateLimited({ retryAfterMs: null }));
		if (!res.ok) {
			return err(
				unavailable(`Places API が ${res.status} を返した`, res.status >= 500),
			);
		}
		const parsed = v.safeParse(
			SearchResponse,
			await res.json().catch(() => null),
		);
		if (!parsed.success) {
			const issue = parsed.issues[0];
			const path = issue === undefined ? null : v.getDotPath(issue);
			return err(
				unavailable(`Places API の応答が想定と違う (${path ?? "応答全体"})`),
			);
		}

		const places = parsed.output.places.slice(0, MAX_PLACES).map((p) => ({
			name: p.displayName?.text ?? null,
			address: p.formattedAddress ?? null,
			business_status: p.businessStatus ?? null,
			open_now: p.currentOpeningHours?.openNow ?? null,
			today_hours: todayHours(p.currentOpeningHours?.weekdayDescriptions, now),
		}));
		return ok({
			data: { places },
			summary: `場所の候補 ${places.length} 件を取得`,
		});
	};

	return {
		tools: [placeSearch],
		async execute(request) {
			if (request.tool !== placeSearch.name) {
				return err(
					validationFailed({ issues: [`未知の道具: ${request.tool}`] }),
				);
			}
			const input = parseToolInput(placeSearch, request.input);
			return input.ok ? search(input.value, request.context.now) : input;
		},
	};
};
