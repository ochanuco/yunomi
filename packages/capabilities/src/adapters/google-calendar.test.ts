import { type DomainError, type Result, toModelJson } from "@yunomi/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallContext, CapabilityResponse } from "../contract.ts";
import {
	calendarCreateEvent,
	calendarListEvents,
} from "../definitions/calendar.ts";
import { createGoogleCalendarAdapter } from "./google-calendar.ts";

type Call = { url: URL; init: RequestInit };
// "hang" は応答を返さず、渡された signal が中断されたときに失敗する。
type Step = Response | Error | "hang";

const credentials = {
	clientId: "client-id",
	clientSecret: "client-secret",
	refreshToken: "refresh-token",
};

const START = Date.parse("2026-10-17T00:00:00Z");
const MESSAGE_ID = "1234567890123456789";
const EVENT_ID = `c0${MESSAGE_ID}`;

type HeaderMap = Record<string, string>;

const json = (body: unknown, status = 200, headers: HeaderMap = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

const token = (value = "tok-1", expiresIn = 3600) =>
	json({ access_token: value, expires_in: expiresIn });

const empty = (status: number, headers: HeaderMap = {}) =>
	new Response(null, { status, headers });

// 並べた応答を順に返す fetch。想定より多く呼ばれたら失敗させる。
const setup = (
	steps: Step[],
	calendarId = "owner@example.com",
	timeoutMs?: number,
) => {
	const calls: Call[] = [];
	let nowMs = START;
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({ url: new URL(String(input)), init: init ?? {} });
		const step = steps.shift();
		if (step === undefined) throw new Error("想定外の fetch");
		if (step instanceof Error) throw step;
		if (step === "hang") {
			const signal = init?.signal;
			return new Promise<Response>((_, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason));
			});
		}
		return step;
	}) as typeof fetch;
	const adapter = createGoogleCalendarAdapter({
		fetch: fetchFn,
		credentials,
		calendarId,
		now: () => new Date(nowMs),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	});
	return {
		adapter,
		calls,
		advance: (ms: number) => {
			nowMs += ms;
		},
	};
};

const context: CallContext = {
	partnerId: "partner-1",
	speakerId: "speaker-1",
	isOwner: true,
	channelId: "channel-1",
	sourceMessageId: MESSAGE_ID,
	now: new Date(START),
};

const listInput = {
	from: "2026-10-18T00:00:00+09:00",
	to: "2026-10-19T00:00:00+09:00",
};

const createInput = {
	summary: "歯医者",
	start: "2026-10-20T15:00:00+09:00",
	end: "2026-10-20T16:00:00+09:00",
	description: "定期検診",
};

type Adapter = ReturnType<typeof createGoogleCalendarAdapter>;

const list = (adapter: Adapter, input: unknown = listInput) =>
	adapter.execute({
		requestId: "req-1",
		tool: calendarListEvents.name,
		input,
		context,
	});

const create = (
	adapter: Adapter,
	input: unknown = createInput,
	ctx: CallContext = context,
) =>
	adapter.execute({
		requestId: "req-1",
		tool: calendarCreateEvent.name,
		input,
		context: ctx,
	});

const successOf = (
	r: Result<CapabilityResponse, DomainError>,
): CapabilityResponse => {
	if (!r.ok) throw new Error(`成功のはず: ${r.error.message}`);
	return r.value;
};

const errorOf = (r: Result<CapabilityResponse, DomainError>): DomainError => {
	if (r.ok) throw new Error("失敗のはず");
	return r.error;
};

const authorization = (call: Call | undefined) =>
	new Headers(call?.init.headers).get("authorization");

describe("tools", () => {
	it("一覧と作成の道具を持つ", () => {
		const { adapter } = setup([]);
		expect(adapter.tools).toEqual([calendarListEvents, calendarCreateEvent]);
	});
});

describe("access token", () => {
	it("refresh token から form encoded で取得し、API に Bearer で渡す", async () => {
		const { adapter, calls } = setup([token(), json({ items: [] })]);
		successOf(await list(adapter));

		const [tokenCall, apiCall] = calls;
		expect(tokenCall?.url.href).toBe("https://oauth2.googleapis.com/token");
		expect(tokenCall?.init.method).toBe("POST");
		expect(new Headers(tokenCall?.init.headers).get("content-type")).toBe(
			"application/x-www-form-urlencoded",
		);
		const form = new URLSearchParams(String(tokenCall?.init.body));
		expect(Object.fromEntries(form)).toEqual({
			client_id: "client-id",
			client_secret: "client-secret",
			refresh_token: "refresh-token",
			grant_type: "refresh_token",
		});
		expect(apiCall?.url.origin).toBe("https://www.googleapis.com");
		expect(authorization(apiCall)).toBe("Bearer tok-1");
	});

	it("期限の 60 秒前までは使い回し、それを過ぎたら取り直す", async () => {
		const { adapter, calls, advance } = setup([
			token("tok-1", 3600),
			json({ items: [] }),
			json({ items: [] }),
			token("tok-2", 3600),
			json({ items: [] }),
		]);
		successOf(await list(adapter));

		advance((3600 - 61) * 1000);
		successOf(await list(adapter));
		expect(calls.map((c) => c.url.host)).toEqual([
			"oauth2.googleapis.com",
			"www.googleapis.com",
			"www.googleapis.com",
		]);
		expect(authorization(calls[2])).toBe("Bearer tok-1");

		advance(1000);
		successOf(await list(adapter));
		expect(calls).toHaveLength(5);
		expect(authorization(calls[4])).toBe("Bearer tok-2");
	});

	it("API が 401 を返したら token を取り直して 1 回だけ再試行する", async () => {
		const { adapter, calls } = setup([
			token("tok-1"),
			empty(401),
			token("tok-2"),
			json({ items: [] }),
		]);
		successOf(await list(adapter));
		expect(calls).toHaveLength(4);
		expect(authorization(calls[1])).toBe("Bearer tok-1");
		expect(authorization(calls[3])).toBe("Bearer tok-2");
	});

	it("取り直した token でも 401 なら、再試行せず retryable でない失敗にする", async () => {
		const { adapter, calls } = setup([
			token("tok-1"),
			empty(401),
			token("tok-2"),
			empty(401),
		]);
		const error = errorOf(await list(adapter));
		expect(error.type).toBe("ExternalServiceUnavailable");
		expect(error.retryable).toBe(false);
		expect(calls).toHaveLength(4);
	});

	it("401 の再試行は作成でも同じ", async () => {
		const { adapter, calls } = setup([
			token("tok-1"),
			empty(401),
			token("tok-2"),
			json({ id: EVENT_ID, htmlLink: "https://calendar.example/e" }),
		]);
		const value = successOf(await create(adapter));
		expect(value.data).toMatchObject({ status: "created" });
		expect(authorization(calls[3])).toBe("Bearer tok-2");
	});

	it("invalid_grant は retryable でない externalServiceUnavailable にする", async () => {
		const { adapter, calls } = setup([
			json({ error: "invalid_grant" }, 400),
			json({ error: "invalid_grant" }, 400),
		]);
		const error = errorOf(await list(adapter));
		expect(error).toMatchObject({
			type: "ExternalServiceUnavailable",
			service: "google_calendar",
			retryable: false,
		});
		expect(error.message).toContain("invalid_grant");
		expect(calls).toHaveLength(1);

		// 失敗した token は覚えず、次の呼び出しでまた取りにいく。
		errorOf(await list(adapter));
		expect(calls).toHaveLength(2);
	});

	it("token endpoint の invalid_client なども retryable でない", async () => {
		const { adapter } = setup([json({ error: "invalid_client" }, 401)]);
		const error = errorOf(await list(adapter));
		expect(error.type).toBe("ExternalServiceUnavailable");
		expect(error.retryable).toBe(false);
	});

	it("token endpoint の 5xx は retryable", async () => {
		const { adapter } = setup([empty(503)]);
		const error = errorOf(await list(adapter));
		expect(error.type).toBe("ExternalServiceUnavailable");
		expect(error.retryable).toBe(true);
	});

	it("token endpoint の 429 は rateLimited", async () => {
		const { adapter } = setup([empty(429, { "retry-after": "10" })]);
		expect(errorOf(await list(adapter))).toMatchObject({
			type: "RateLimited",
			retryAfterMs: 10_000,
		});
	});

	it("token endpoint に繋がらなければ retryable", async () => {
		const { adapter } = setup([new TypeError("network")]);
		const error = errorOf(await list(adapter));
		expect(error.type).toBe("ExternalServiceUnavailable");
		expect(error.retryable).toBe(true);
	});

	it("token の応答が想定と違えば externalServiceUnavailable", async () => {
		const { adapter } = setup([json({ access_token: "tok-1" })]);
		const error = errorOf(await list(adapter));
		expect(error.type).toBe("ExternalServiceUnavailable");
		expect(error.message).toContain("expires_in");
	});
});

describe("calendar_list_events", () => {
	it("calendarId を URL エンコードし、期間と並びを query で渡す", async () => {
		const { adapter, calls } = setup(
			[token(), json({ items: [] })],
			"team#1@group.calendar.google.com",
		);
		successOf(await list(adapter));

		const api = calls[1];
		expect(api?.init.method).toBe("GET");
		expect(api?.url.pathname).toBe(
			"/calendar/v3/calendars/team%231%40group.calendar.google.com/events",
		);
		expect(Object.fromEntries(api?.url.searchParams ?? [])).toEqual({
			timeMin: listInput.from,
			timeMax: listInput.to,
			singleEvents: "true",
			orderBy: "startTime",
			maxResults: "50",
		});
	});

	it("時刻付き・終日・summary 無しの予定を詰め直す", async () => {
		const { adapter } = setup([
			token(),
			json({
				items: [
					{
						id: "e1",
						summary: "打ち合わせ",
						location: "渋谷",
						attendees: [{ email: "x@example.com" }],
						start: { dateTime: "2026-10-18T10:00:00+09:00" },
						end: { dateTime: "2026-10-18T11:00:00+09:00" },
					},
					{
						summary: "祝日",
						start: { date: "2026-10-18" },
						end: { date: "2026-10-19" },
					},
					{
						start: { dateTime: "2026-10-18T20:00:00+09:00" },
						end: { dateTime: "2026-10-18T21:00:00+09:00" },
					},
				],
			}),
		]);
		const value = successOf(await list(adapter));
		expect(value.data).toEqual({
			events: [
				{
					summary: "打ち合わせ",
					start: new Date("2026-10-18T01:00:00Z"),
					end: new Date("2026-10-18T02:00:00Z"),
					allDay: false,
					location: "渋谷",
				},
				{
					summary: "祝日",
					start: "2026-10-18",
					end: "2026-10-19",
					allDay: true,
					location: null,
				},
				{
					summary: null,
					start: new Date("2026-10-18T11:00:00Z"),
					end: new Date("2026-10-18T12:00:00Z"),
					allDay: false,
					location: null,
				},
			],
			truncated: false,
		});
	});

	it("dateTime は Date で返り、モデルへの直列化で JST の書式になる", async () => {
		const { adapter } = setup([
			token(),
			json({
				items: [
					{
						start: { dateTime: "2026-10-18T10:00:00-07:00" },
						end: { dateTime: "2026-10-18T11:00:00Z" },
					},
				],
			}),
		]);
		const value = successOf(await list(adapter));
		expect(value.data).toMatchObject({
			events: [
				{
					start: new Date("2026-10-18T17:00:00Z"),
					end: new Date("2026-10-18T11:00:00Z"),
				},
			],
		});
		expect(JSON.parse(toModelJson(value.data))).toMatchObject({
			events: [{ start: "2026-10-19 02:00 JST", end: "2026-10-18 20:00 JST" }],
		});
	});

	it("nextPageToken があれば truncated にする", async () => {
		const { adapter } = setup([
			token(),
			json({ items: [], nextPageToken: "next" }),
		]);
		expect(successOf(await list(adapter)).data).toEqual({
			events: [],
			truncated: true,
		});
	});

	it("items が無い応答は予定 0 件として扱う", async () => {
		const { adapter } = setup([token(), json({})]);
		expect(successOf(await list(adapter)).data).toEqual({
			events: [],
			truncated: false,
		});
	});

	it("Audit 用の summary には件数と期間だけを入れ、タイトルや場所を入れない", async () => {
		const { adapter } = setup([
			token(),
			json({
				items: [
					{
						summary: "極秘の面談",
						location: "本社 12 階",
						start: { dateTime: "2026-10-18T10:00:00+09:00" },
						end: { dateTime: "2026-10-18T11:00:00+09:00" },
					},
					{
						summary: "人事の相談",
						start: { date: "2026-10-18" },
						end: { date: "2026-10-19" },
					},
				],
			}),
		]);
		const { summary } = successOf(await list(adapter));
		expect(summary).toBe(
			`予定 2 件を取得（${listInput.from} 〜 ${listInput.to}）`,
		);
		expect(summary).not.toContain("極秘");
		expect(summary).not.toContain("人事");
		expect(summary).not.toContain("本社");
	});

	it("truncated のときは summary に続きがあると書く", async () => {
		const { adapter } = setup([
			token(),
			json({ items: [], nextPageToken: "next" }),
		]);
		expect(successOf(await list(adapter)).summary).toContain("続きあり");
	});

	it.each([
		["items が配列でない", { items: "x" }, "items"],
		[
			"start が無い",
			{ items: [{ end: { date: "2026-10-19" } }] },
			"items.0.start",
		],
		[
			"start に dateTime も date も無い",
			{ items: [{ start: {}, end: { date: "2026-10-19" } }] },
			"items.0.start",
		],
	])(
		"応答が想定と違えば externalServiceUnavailable にする（%s）",
		async (_, body, path) => {
			const { adapter } = setup([token(), json(body)]);
			const error = errorOf(await list(adapter));
			expect(error.type).toBe("ExternalServiceUnavailable");
			expect(error.retryable).toBe(true);
			expect(error.message).toContain(path);
		},
	);

	it("応答が JSON でなければ externalServiceUnavailable にする", async () => {
		const { adapter } = setup([
			token(),
			new Response("<html>", { status: 200 }),
		]);
		expect(errorOf(await list(adapter)).type).toBe(
			"ExternalServiceUnavailable",
		);
	});
});

describe("calendar_create_event", () => {
	it("本文に ID（c0 + メッセージ ID）・タイトル・説明・開始・終了を入れて POST する", async () => {
		const { adapter, calls } = setup([
			token(),
			json({ id: EVENT_ID, htmlLink: "https://calendar.example/e" }),
		]);
		const value = successOf(await create(adapter));

		const api = calls[1];
		expect(api?.init.method).toBe("POST");
		expect(api?.url.pathname).toBe(
			"/calendar/v3/calendars/owner%40example.com/events",
		);
		expect(new Headers(api?.init.headers).get("content-type")).toBe(
			"application/json",
		);
		expect(JSON.parse(String(api?.init.body))).toEqual({
			id: EVENT_ID,
			summary: "歯医者",
			description: "定期検診",
			start: { dateTime: "2026-10-20T15:00:00+09:00" },
			end: { dateTime: "2026-10-20T16:00:00+09:00" },
		});
		expect(value.data).toEqual({
			status: "created",
			id: EVENT_ID,
			htmlLink: "https://calendar.example/e",
		});
	});

	it("description が null なら本文に含めない", async () => {
		const { adapter, calls } = setup([
			token(),
			json({ id: EVENT_ID, htmlLink: "https://calendar.example/e" }),
		]);
		successOf(await create(adapter, { ...createInput, description: null }));
		const body = JSON.parse(String(calls[1]?.init.body));
		expect(body).not.toHaveProperty("description");
	});

	it("Audit 用の summary にタイトルや説明を入れない", async () => {
		const { adapter } = setup([
			token(),
			json({ id: EVENT_ID, htmlLink: "https://calendar.example/e" }),
		]);
		const { summary } = successOf(await create(adapter));
		expect(summary).toBe(
			`予定を登録した（${createInput.start} 〜 ${createInput.end}）`,
		);
		expect(summary).not.toContain("歯医者");
		expect(summary).not.toContain("定期検診");
	});

	it("409 は二重登録として成功扱いにする", async () => {
		const { adapter } = setup([
			token(),
			json({ error: { code: 409, message: "identifier already exists" } }, 409),
		]);
		const value = successOf(await create(adapter));
		expect(value.data).toEqual({ status: "already_exists", id: EVENT_ID });
		expect(value.summary).toContain("登録済み");
	});

	it("同じ発言からの 2 回目は同じ ID で送る", async () => {
		const { adapter, calls } = setup([
			token(),
			json({ id: EVENT_ID, htmlLink: "https://calendar.example/e" }),
			json({}, 409),
		]);
		successOf(await create(adapter));
		successOf(await create(adapter));
		const ids = [1, 2].map((i) => JSON.parse(String(calls[i]?.init.body)).id);
		expect(ids).toEqual([EVENT_ID, EVENT_ID]);
	});

	it.each([
		["空", ""],
		["短すぎて ID が 5 文字に届かない", "12"],
		["数字以外を含む", "12345abc-6"],
		["大文字を含む", "ABCDE"],
		["予定 ID の長さの上限を超える", "1".repeat(1023)],
	])(
		"メッセージ ID が予定 ID の制約を満たさなければ validationFailed にする（%s）",
		async (_, sourceMessageId) => {
			const { adapter, calls } = setup([]);
			const error = errorOf(
				await create(adapter, createInput, { ...context, sourceMessageId }),
			);
			expect(error.type).toBe("ValidationFailed");
			expect(calls).toHaveLength(0);
		},
	);

	it("予定 ID の長さの上限ちょうどは受け付ける", async () => {
		const sourceMessageId = "1".repeat(1022);
		const { adapter, calls } = setup([
			token(),
			json({
				id: `c0${sourceMessageId}`,
				htmlLink: "https://calendar.example/e",
			}),
		]);
		successOf(
			await create(adapter, createInput, { ...context, sourceMessageId }),
		);
		expect(JSON.parse(String(calls[1]?.init.body)).id).toHaveLength(1024);
	});

	it.each([
		["id が無い", { htmlLink: "https://calendar.example/e" }, "id"],
		["htmlLink が無い", { id: EVENT_ID }, "htmlLink"],
	])(
		"応答が想定と違えば externalServiceUnavailable にする（%s）",
		async (_, body, path) => {
			const { adapter } = setup([token(), json(body)]);
			const error = errorOf(await create(adapter));
			expect(error.type).toBe("ExternalServiceUnavailable");
			expect(error.message).toContain(path);
		},
	);
});

describe.each([
	["calendar_list_events", list],
	["calendar_create_event", create],
] as const)("%s の HTTP エラー", (_, run) => {
	it("429 は rateLimited にして Retry-After を ms にする", async () => {
		const { adapter } = setup([token(), empty(429, { "retry-after": "30" })]);
		expect(errorOf(await run(adapter))).toMatchObject({
			type: "RateLimited",
			retryable: true,
			retryAfterMs: 30_000,
		});
	});

	it("Retry-After が HTTP の日時でも ms にする", async () => {
		const at = new Date(START + 45_000).toUTCString();
		const { adapter } = setup([token(), empty(429, { "retry-after": at })]);
		expect(errorOf(await run(adapter))).toMatchObject({
			type: "RateLimited",
			retryAfterMs: 45_000,
		});
	});

	it("Retry-After が無ければ null", async () => {
		const { adapter } = setup([token(), empty(429)]);
		expect(errorOf(await run(adapter))).toMatchObject({
			type: "RateLimited",
			retryAfterMs: null,
		});
	});

	it.each([500, 502, 503])(
		"%i は retryable な externalServiceUnavailable",
		async (status) => {
			const { adapter } = setup([token(), empty(status)]);
			expect(errorOf(await run(adapter))).toMatchObject({
				type: "ExternalServiceUnavailable",
				service: "google_calendar",
				retryable: true,
			});
		},
	);

	it.each([403, 404])(
		"%i は retryable でない externalServiceUnavailable",
		async (status) => {
			const { adapter } = setup([token(), empty(status)]);
			const error = errorOf(await run(adapter));
			expect(error).toMatchObject({
				type: "ExternalServiceUnavailable",
				service: "google_calendar",
				retryable: false,
			});
			expect(error.message).toContain(String(status));
		},
	);

	it("fetch の失敗は retryable な externalServiceUnavailable", async () => {
		const { adapter } = setup([token(), new TypeError("network")]);
		expect(errorOf(await run(adapter))).toMatchObject({
			type: "ExternalServiceUnavailable",
			service: "google_calendar",
			retryable: true,
		});
	});

	it("Calendar API が時間内に応答しなければ retryable な externalServiceUnavailable", async () => {
		const { adapter } = setup([token(), "hang"], undefined, 20);
		const error = errorOf(await run(adapter));
		expect(error).toMatchObject({
			type: "ExternalServiceUnavailable",
			service: "google_calendar",
			retryable: true,
		});
		expect(error.message).toContain("Calendar API");
		expect(error.message).toContain("タイムアウト");
	});

	describe("403 のクォータ超過", () => {
		const quotaBodies = [
			[
				"errors の rateLimitExceeded",
				{
					error: {
						code: 403,
						message: "Rate Limit Exceeded",
						errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }],
						status: "PERMISSION_DENIED",
					},
				},
			],
			[
				"errors の userRateLimitExceeded",
				{
					error: {
						code: 403,
						errors: [
							{ domain: "usageLimits", reason: "userRateLimitExceeded" },
						],
					},
				},
			],
			[
				"details の RATE_LIMIT_EXCEEDED",
				{
					error: {
						code: 403,
						status: "PERMISSION_DENIED",
						details: [
							{
								"@type": "type.googleapis.com/google.rpc.ErrorInfo",
								reason: "RATE_LIMIT_EXCEEDED",
							},
						],
					},
				},
			],
			[
				"status の RATE_LIMIT_EXCEEDED",
				{ error: { code: 403, status: "RATE_LIMIT_EXCEEDED" } },
			],
		] as const;

		it.each(quotaBodies)("%s は rateLimited にする", async (_, body) => {
			const { adapter } = setup([token(), json(body, 403)]);
			expect(errorOf(await run(adapter))).toMatchObject({
				type: "RateLimited",
				retryable: true,
				retryAfterMs: null,
			});
		});

		it("Retry-After があれば ms にする", async () => {
			const { adapter } = setup([
				token(),
				json(quotaBodies[0][1], 403, { "retry-after": "20" }),
			]);
			expect(errorOf(await run(adapter))).toMatchObject({
				type: "RateLimited",
				retryAfterMs: 20_000,
			});
		});

		it.each([
			[
				"クォータ以外の reason",
				json(
					{
						error: {
							code: 403,
							errors: [{ reason: "insufficientPermissions" }],
							status: "PERMISSION_DENIED",
							details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }],
						},
					},
					403,
				),
			],
			["JSON でない本文", new Response("<html>", { status: 403 })],
			["空の本文", empty(403)],
			["error が object でない本文", json({ error: "forbidden" }, 403)],
			["errors が配列でない本文", json({ error: { errors: "x" } }, 403)],
		])(
			"%s は従来どおり retryable でない externalServiceUnavailable にする",
			async (_, response) => {
				const { adapter } = setup([token(), response]);
				expect(errorOf(await run(adapter))).toMatchObject({
					type: "ExternalServiceUnavailable",
					service: "google_calendar",
					retryable: false,
				});
			},
		);

		it("403 以外の status は本文にクォータ超過の reason があっても rateLimited にしない", async () => {
			const { adapter } = setup([token(), json(quotaBodies[0][1], 404)]);
			expect(errorOf(await run(adapter)).type).toBe(
				"ExternalServiceUnavailable",
			);
		});
	});
});

describe("タイムアウト", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("token endpoint が時間内に応答しなければ retryable な externalServiceUnavailable", async () => {
		const { adapter, calls } = setup(["hang"], undefined, 20);
		const error = errorOf(await list(adapter));
		expect(error).toMatchObject({
			type: "ExternalServiceUnavailable",
			service: "google_calendar",
			retryable: true,
		});
		expect(error.message).toContain("token endpoint");
		expect(error.message).toContain("タイムアウト");
		expect(calls).toHaveLength(1);
	});

	it("タイムアウトした token は覚えず、次の呼び出しでまた取りにいく", async () => {
		const { adapter, calls } = setup(
			["hang", token(), json({ items: [] })],
			undefined,
			20,
		);
		errorOf(await list(adapter));
		successOf(await list(adapter));
		expect(calls).toHaveLength(3);
	});

	it("token endpoint と Calendar API の fetch に、既定 10 秒の signal を付ける", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const { adapter, calls } = setup([token(), json({ items: [] })]);
		successOf(await list(adapter));
		expect(timeout.mock.calls).toEqual([[10_000], [10_000]]);
		for (const call of calls) {
			expect(call.init.signal).toBeInstanceOf(AbortSignal);
		}
	});

	it("deps の timeoutMs で秒数を上書きできる", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const { adapter } = setup([token(), json({ items: [] })], undefined, 5000);
		successOf(await list(adapter));
		expect(timeout.mock.calls).toEqual([[5000], [5000]]);
	});

	it("401 の取り直しの fetch にも signal を付ける", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const { adapter } = setup([
			token(),
			empty(401),
			token("tok-2"),
			json({ items: [] }),
		]);
		successOf(await list(adapter));
		expect(timeout).toHaveBeenCalledTimes(4);
	});
});

describe("execute の入力", () => {
	it("未知の道具名は validationFailed にする", async () => {
		const { adapter, calls } = setup([]);
		const result = await adapter.execute({
			requestId: "req-1",
			tool: "calendar_delete_event",
			input: {},
			context,
		});
		const error = errorOf(result);
		expect(error.type).toBe("ValidationFailed");
		expect(error.message).toContain("calendar_delete_event");
		expect(calls).toHaveLength(0);
	});

	it.each([
		["一覧の期間が逆", list, { from: listInput.to, to: listInput.from }],
		["一覧の入力が object でない", list, "x"],
		["作成のタイトルが空", create, { ...createInput, summary: " " }],
		[
			"作成の終了が開始より前",
			create,
			{ ...createInput, end: createInput.start },
		],
		[
			"作成に開始が無い",
			create,
			{ summary: "x", end: createInput.end, description: null },
		],
	])(
		"道具の入力を検証し直し、不正なら API を呼ばずに validationFailed にする（%s）",
		async (_, run, input) => {
			const { adapter, calls } = setup([]);
			expect(errorOf(await run(adapter, input)).type).toBe("ValidationFailed");
			expect(calls).toHaveLength(0);
		},
	);
});
