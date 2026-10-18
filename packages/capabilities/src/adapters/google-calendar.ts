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
import {
	type CalendarCreateEventInput,
	type CalendarListEventsInput,
	calendarCreateEvent,
	calendarListEvents,
} from "../definitions/calendar.ts";
import { parseToolInput } from "../input.ts";

const SERVICE = "google_calendar";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/calendar/v3";
const TOKEN_REUSE_MARGIN_MS = 60_000;
const MAX_RESULTS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;

// Google Calendar の予定 ID は base32hex の文字（0-9 と a-v）で 5〜1024 文字。
const EVENT_ID_PREFIX = "c0";
const EVENT_ID_PATTERN = /^[0-9a-v]{5,1024}$/;

export type GoogleCalendarDeps = {
	fetch: typeof fetch;
	credentials: {
		clientId: string;
		clientSecret: string;
		refreshToken: string;
	};
	calendarId: string;
	now?: () => Date;
	/** token endpoint と Calendar API への fetch ごとの待ち時間の上限（ms）。既定は 10 秒。 */
	timeoutMs?: number;
};

type AccessToken = { readonly value: string; readonly expiresAt: number };

const TokenResponse = v.object({
	access_token: v.pipe(v.string(), v.minLength(1)),
	expires_in: v.number(),
});

const OAuthErrorBody = v.object({
	error: v.pipe(v.string(), v.regex(/^[a-z_]{1,40}$/)),
});

const ApiErrorReason = v.object({ reason: v.optional(v.string()) });

const ApiErrorBody = v.object({
	error: v.object({
		status: v.optional(v.string()),
		errors: v.optional(v.array(ApiErrorReason)),
		details: v.optional(v.array(ApiErrorReason)),
	}),
});

const EventTime = v.union([
	v.object({ dateTime: v.string() }),
	v.object({ date: v.string() }),
]);

const ListResponse = v.object({
	items: v.optional(
		v.array(
			v.object({
				summary: v.optional(v.string()),
				location: v.optional(v.string()),
				start: EventTime,
				end: EventTime,
			}),
		),
		[],
	),
	nextPageToken: v.optional(v.string()),
});

const CreateResponse = v.object({
	id: v.string(),
	htmlLink: v.string(),
});

// externalServiceUnavailable は retryable: true で作られる。直らない失敗は retryable を下げる。
const unavailable = (detail: string, retryable = true): DomainError => {
	const base = externalServiceUnavailable({ service: SERVICE });
	return { ...base, retryable, message: `${base.message}: ${detail}` };
};

// Calendar API はクォータ超過を 429 ではなく 403 で返すことがある。reason は errors では rateLimitExceeded、
// details の ErrorInfo では RATE_LIMIT_EXCEEDED と表記が違うので、大文字小文字と _ を無視して比べる。
const QUOTA_REASONS = new Set(["ratelimitexceeded", "userratelimitexceeded"]);

const isQuotaExceeded = (body: unknown): boolean => {
	const parsed = v.safeParse(ApiErrorBody, body);
	if (!parsed.success) return false;
	const { status, errors = [], details = [] } = parsed.output.error;
	return [
		status,
		...errors.map((e) => e.reason),
		...details.map((d) => d.reason),
	].some(
		(reason) =>
			reason !== undefined &&
			QUOTA_REASONS.has(reason.replaceAll("_", "").toLowerCase()),
	);
};

const parseRetryAfter = (
	header: string | null,
	nowMs: number,
): number | null => {
	if (header === null) return null;
	if (/^\d+$/.test(header.trim())) return Number(header) * 1000;
	const at = Date.parse(header);
	return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
};

const readJson = async <TSchema extends v.GenericSchema>(
	res: Response,
	schema: TSchema,
	what: string,
): Promise<Result<v.InferOutput<TSchema>, DomainError>> => {
	const parsed = v.safeParse(schema, await res.json().catch(() => null));
	if (parsed.success) return ok(parsed.output);
	const issue = parsed.issues[0];
	const path = issue === undefined ? null : v.getDotPath(issue);
	return err(unavailable(`${what}の応答が想定と違う (${path ?? "応答全体"})`));
};

/**
 * Google Calendar の adapter。オーナーのカレンダー 1 つに対して、予定の一覧と作成を行う。
 * access token はインスタンス内に持つので、複数のターンで使い回す。
 */
export const createGoogleCalendarAdapter = (
	deps: GoogleCalendarDeps,
): CapabilityAdapter => {
	// Workers の fetch は this が globalThis でないと Illegal invocation になるため、プロパティ越しに呼ばない。
	const doFetch = deps.fetch;
	const now = deps.now ?? (() => new Date());
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const eventsUrl = `${API_BASE}/calendars/${encodeURIComponent(deps.calendarId)}/events`;
	let cached: AccessToken | null = null;

	const retryAfterMs = (res: Response): number | null =>
		parseRetryAfter(res.headers.get("retry-after"), now().getTime());

	const request = async (
		what: string,
		url: string,
		init: RequestInit,
	): Promise<Result<Response, DomainError>> => {
		try {
			return ok(
				await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
			);
		} catch (e) {
			const timedOut = e instanceof Error && e.name === "TimeoutError";
			return err(
				unavailable(
					timedOut
						? `${what} の応答がタイムアウトした`
						: `${what} に接続できない`,
				),
			);
		}
	};

	// 4xx は 429 を除いて、リクエストを直すまで通らない。invalid_grant（失効・取り消された refresh token）もここ。
	const tokenFailure = async (res: Response): Promise<DomainError> => {
		if (res.status === 429) {
			return rateLimited({ retryAfterMs: retryAfterMs(res) });
		}
		if (res.status >= 500) {
			return unavailable(`token endpoint が ${res.status} を返した`);
		}
		const body = v.safeParse(
			OAuthErrorBody,
			await res.json().catch(() => null),
		);
		const code = body.success ? ` ${body.output.error}` : "";
		return unavailable(`token を取得できない (${res.status}${code})`, false);
	};

	const requestToken = async (): Promise<Result<AccessToken, DomainError>> => {
		const { clientId, clientSecret, refreshToken } = deps.credentials;
		const sent = await request("token endpoint", TOKEN_URL, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: clientId,
				client_secret: clientSecret,
				refresh_token: refreshToken,
				grant_type: "refresh_token",
			}).toString(),
		});
		if (!sent.ok) return sent;
		const res = sent.value;
		if (!res.ok) return err(await tokenFailure(res));
		const body = await readJson(res, TokenResponse, "token");
		if (!body.ok) return body;
		return ok({
			value: body.value.access_token,
			expiresAt: now().getTime() + body.value.expires_in * 1000,
		});
	};

	const accessToken = async (
		forceRefresh: boolean,
	): Promise<Result<string, DomainError>> => {
		if (
			!forceRefresh &&
			cached !== null &&
			now().getTime() < cached.expiresAt - TOKEN_REUSE_MARGIN_MS
		) {
			return ok(cached.value);
		}
		cached = null;
		const token = await requestToken();
		if (!token.ok) return token;
		cached = token.value;
		return ok(token.value.value);
	};

	const callOnce = async (
		url: string,
		init: { method: string; body?: string },
		forceRefresh: boolean,
	): Promise<Result<Response, DomainError>> => {
		const token = await accessToken(forceRefresh);
		if (!token.ok) return token;
		return request("Calendar API", url, {
			...init,
			headers: {
				authorization: `Bearer ${token.value}`,
				...(init.body === undefined
					? {}
					: { "content-type": "application/json" }),
			},
		});
	};

	// 401 は access token の失効。取り直して 1 回だけ再試行し、それでも 401 なら呼び出し側に返す。
	const send = async (
		url: string,
		init: { method: string; body?: string },
	): Promise<Result<Response, DomainError>> => {
		const first = await callOnce(url, init, false);
		if (!first.ok || first.value.status !== 401) return first;
		return callOnce(url, init, true);
	};

	// クォータ超過でない 403 は権限、404 はカレンダーが無い、401 は取り直しても通らなかった。設定を直すまで直らない。
	const apiFailure = async (res: Response): Promise<DomainError> => {
		if (
			res.status === 429 ||
			(res.status === 403 &&
				isQuotaExceeded(await res.json().catch(() => null)))
		) {
			return rateLimited({ retryAfterMs: retryAfterMs(res) });
		}
		const detail =
			res.status === 404
				? "カレンダーが見つからない (404)"
				: `Calendar API が ${res.status} を返した`;
		return unavailable(detail, res.status >= 500);
	};

	const listEvents = async (
		input: CalendarListEventsInput,
	): Promise<Result<CapabilityResponse, DomainError>> => {
		const query = new URLSearchParams({
			timeMin: input.from,
			timeMax: input.to,
			singleEvents: "true",
			orderBy: "startTime",
			maxResults: String(MAX_RESULTS),
		});
		const res = await send(`${eventsUrl}?${query}`, { method: "GET" });
		if (!res.ok) return res;
		if (!res.value.ok) return err(await apiFailure(res.value));
		const body = await readJson(res.value, ListResponse, "予定の一覧");
		if (!body.ok) return body;

		// 終日の予定の end は Google の仕様どおり翌日の日付（含まない側）のまま返す。
		// 時刻付きの start / end は Date で返す。モデルへ渡す直列化（toModelJson）で JST の書式になる。
		const events = body.value.items.map((item) => ({
			summary: item.summary ?? null,
			start:
				"dateTime" in item.start
					? new Date(item.start.dateTime)
					: item.start.date,
			end: "dateTime" in item.end ? new Date(item.end.dateTime) : item.end.date,
			allDay: !("dateTime" in item.start),
			location: item.location ?? null,
		}));
		const truncated = body.value.nextPageToken !== undefined;
		return ok({
			data: { events, truncated },
			summary: `予定 ${events.length} 件を取得（${input.from} 〜 ${input.to}${truncated ? "、続きあり" : ""}）`,
		});
	};

	const createEvent = async (
		input: CalendarCreateEventInput,
		sourceMessageId: string,
	): Promise<Result<CapabilityResponse, DomainError>> => {
		// 予定 ID を発言（Discord のメッセージ ID）から決めるのは、同じ発言からの 2 回目の登録を Google に 409 で弾かせるため。
		// 同じ Partner の再試行も、同じ依頼に応じた別の Partner も、二重登録にならない。
		// 代わりに、1 つの発言から登録できる予定は 1 件になる。
		const id = `${EVENT_ID_PREFIX}${sourceMessageId}`;
		if (!EVENT_ID_PATTERN.test(id)) {
			return err(
				validationFailed({
					issues: [
						"sourceMessageId から予定 ID を作れない（0-9 と a-v の 5〜1024 文字にする）",
					],
				}),
			);
		}
		const res = await send(eventsUrl, {
			method: "POST",
			body: JSON.stringify({
				id,
				summary: input.summary,
				...(input.description === null
					? {}
					: { description: input.description }),
				start: { dateTime: input.start },
				end: { dateTime: input.end },
			}),
		});
		if (!res.ok) return res;
		const period = `${input.start} 〜 ${input.end}`;
		if (res.value.status === 409) {
			return ok({
				data: { status: "already_exists", id },
				summary: `予定は登録済みだった（${period}）`,
			});
		}
		if (!res.value.ok) return err(await apiFailure(res.value));
		const body = await readJson(res.value, CreateResponse, "予定の作成");
		if (!body.ok) return body;
		return ok({
			data: {
				status: "created",
				id: body.value.id,
				htmlLink: body.value.htmlLink,
			},
			summary: `予定を登録した（${period}）`,
		});
	};

	return {
		tools: [calendarListEvents, calendarCreateEvent],
		async execute(request) {
			switch (request.tool) {
				case calendarListEvents.name: {
					const input = parseToolInput(calendarListEvents, request.input);
					return input.ok ? listEvents(input.value) : input;
				}
				case calendarCreateEvent.name: {
					const input = parseToolInput(calendarCreateEvent, request.input);
					return input.ok
						? createEvent(input.value, request.context.sourceMessageId)
						: input;
				}
				default:
					return err(
						validationFailed({ issues: [`未知の道具: ${request.tool}`] }),
					);
			}
		},
	};
};
