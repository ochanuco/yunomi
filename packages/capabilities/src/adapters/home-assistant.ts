import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
	validationFailed,
} from "@yunomi/core";
import * as v from "valibot";
import type { CapabilityAdapter, CapabilityResponse } from "../contract.ts";
import { homeState } from "../definitions/home.ts";
import { parseToolInput } from "../input.ts";

const SERVICE = "home_assistant";
const DEFAULT_TIMEOUT_MS = 10_000;

// domain.object_id。パスに埋めるので、Home Assistant が作る形以外は設定の段階で落とす。
const ENTITY_ID_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+$/;

/** `HOME_ENTITY_IDS`（カンマ区切り）を entity ID の一覧にする。形の崩れたものは捨てる。 */
export const parseHomeEntityIds = (raw: string): string[] =>
	raw
		.split(",")
		.map((id) => id.trim())
		.filter((id) => ENTITY_ID_PATTERN.test(id));

export type HomeAssistantDeps = {
	fetch: typeof fetch;
	/** Home Assistant の origin。 */
	baseUrl: string;
	/** long-lived access token。 */
	token: string;
	entityIds: readonly string[];
	/** 全 entity の読み取りの待ち時間の上限（ms）。既定は 10 秒。 */
	timeoutMs?: number;
};

const StateResponse = v.object({
	entity_id: v.string(),
	state: v.string(),
	attributes: v.optional(v.record(v.string(), v.unknown()), {}),
	last_changed: v.string(),
});

type StateResponse = v.InferOutput<typeof StateResponse>;

// externalServiceUnavailable は retryable: true で作られる。直らない失敗は retryable を下げる。
const unavailable = (detail: string, retryable = true): DomainError => {
	const base = externalServiceUnavailable({ service: SERVICE });
	return { ...base, retryable, message: `${base.message}: ${detail}` };
};

const text = (value: unknown): string | null =>
	typeof value === "string" ? value : null;

const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

// 町名のあとの丁目・番地は数字で始まる。漢数字は町名にも使われる（三条など）ので区切りにしない。
const TOWN_END = /[0-9０-９]/;

/**
 * Companion アプリの住所センサーの state は番地までの住所。属性には市区町村までしかないので、
 * 住所の文字列から町名までを切り出し、丁目と番地は捨てる。切り出せなければ市区町村まで。
 */
const coarseAddress = (s: StateResponse): string | null => {
	const area = text(s.attributes.administrative_area) ?? "";
	const locality = text(s.attributes.locality) ?? "";
	const prefix = `${area}${locality}`;
	if (prefix === "") return null;
	const at = s.state.indexOf(prefix);
	if (at < 0) return prefix;
	const rest = s.state.slice(at + prefix.length);
	const end = rest.search(TOWN_END);
	return prefix + (end < 0 ? rest : rest.slice(0, end));
};

const isGeocodedAddress = (s: StateResponse): boolean =>
	"iso_country_code" in s.attributes;

const stateOf = (s: StateResponse): string | Date | null => {
	if (isGeocodedAddress(s)) return coarseAddress(s);
	// 次のアラームなどの時刻は UTC の文字列で来るので、モデルに JST で渡るよう Date にする。
	if (s.attributes.device_class === "timestamp") {
		const at = new Date(s.state);
		if (!Number.isNaN(at.getTime())) return at;
	}
	return s.state;
};

// person や device_tracker の属性には緯度・経度が入るので、返す属性を名指しで選ぶ。
const toEntity = (s: StateResponse) => ({
	entity_id: s.entity_id,
	name: text(s.attributes.friendly_name),
	state: stateOf(s),
	unit: text(s.attributes.unit_of_measurement),
	last_changed: new Date(s.last_changed),
	// weather の state は天気の種類だけで、気温と湿度は属性にしかない。
	...(s.entity_id.startsWith("weather.")
		? {
				temperature: num(s.attributes.temperature),
				temperature_unit: text(s.attributes.temperature_unit),
				humidity: num(s.attributes.humidity),
			}
		: {}),
});

type Fetched =
	| { type: "found"; state: StateResponse }
	| { type: "missing"; entityId: string };

/**
 * Home Assistant の REST API で、設定した entity の状態を読む adapter。読み取りだけで、状態を持たない。
 * summary には件数だけを書き、state は入れない（在宅かどうかを Audit に残さない）。
 */
export const createHomeAssistantAdapter = (
	deps: HomeAssistantDeps,
): CapabilityAdapter => {
	// Workers の fetch は this が globalThis でないと Illegal invocation になるため、プロパティ越しに呼ばない。
	const doFetch = deps.fetch;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const baseUrl = deps.baseUrl.replace(/\/+$/, "");

	const fetchOne = async (
		entityId: string,
		signal: AbortSignal,
	): Promise<Result<Fetched, DomainError>> => {
		let res: Response;
		try {
			res = await doFetch(
				`${baseUrl}/api/states/${encodeURIComponent(entityId)}`,
				{
					method: "GET",
					headers: {
						Authorization: `Bearer ${deps.token}`,
						Accept: "application/json",
					},
					signal,
				},
			);
		} catch (e) {
			const timedOut = e instanceof Error && e.name === "TimeoutError";
			return err(
				unavailable(
					timedOut
						? "Home Assistant の応答がタイムアウトした"
						: "Home Assistant に接続できない",
				),
			);
		}
		if (res.status === 404) return ok({ type: "missing", entityId });
		if (!res.ok) {
			return err(
				unavailable(
					`Home Assistant が ${res.status} を返した`,
					res.status >= 500,
				),
			);
		}
		const parsed = v.safeParse(
			StateResponse,
			await res.json().catch(() => null),
		);
		if (!parsed.success) {
			return err(unavailable("Home Assistant の応答が想定と違う"));
		}
		return ok({ type: "found", state: parsed.output });
	};

	const read = async (): Promise<Result<CapabilityResponse, DomainError>> => {
		const signal = AbortSignal.timeout(timeoutMs);
		const results = await Promise.all(
			deps.entityIds.map((id) => fetchOne(id, signal)),
		);
		const found: StateResponse[] = [];
		const missing: string[] = [];
		for (const r of results) {
			if (!r.ok) return r;
			if (r.value.type === "found") found.push(r.value.state);
			else missing.push(r.value.entityId);
		}
		if (found.length === 0) {
			return err(unavailable("設定した entity が 1 つも見つからない", false));
		}
		return ok({
			data: { entities: found.map(toEntity), missing },
			summary: `entity ${found.length} 件を取得、${missing.length} 件は見つからない`,
		});
	};

	return {
		tools: [homeState],
		async execute(request) {
			if (request.tool !== homeState.name) {
				return err(
					validationFailed({ issues: [`未知の道具: ${request.tool}`] }),
				);
			}
			const input = parseToolInput(homeState, request.input);
			return input.ok ? read() : input;
		},
	};
};
