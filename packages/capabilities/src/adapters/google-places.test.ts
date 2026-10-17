import type { DomainError, Result } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import type { CallContext, CapabilityResponse } from "../contract.ts";
import { placeSearch } from "../definitions/place.ts";
import { createGooglePlacesAdapter } from "./google-places.ts";

type Call = { url: URL; init: RequestInit };
type Step = Response | Error | "hang";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const setup = (steps: Step[], timeoutMs?: number) => {
	const calls: Call[] = [];
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
	const adapter = createGooglePlacesAdapter({
		fetch: fetchFn,
		apiKey: "key-1",
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	});
	return { adapter, calls };
};

// 2026-10-17 は土曜日（JST も同じ）
const NOW = new Date("2026-10-17T03:00:00Z");

const contextAt = (now: Date): CallContext => ({
	partnerId: "partner-1",
	speakerId: "speaker-1",
	isOwner: true,
	channelId: "channel-1",
	sourceMessageId: "1234567890123456789",
	now,
});

const search = (
	adapter: ReturnType<typeof setup>["adapter"],
	input: unknown = { query: "くずは 麦とラーメン" },
	now: Date = NOW,
) =>
	adapter.execute({
		requestId: "req-1",
		tool: placeSearch.name,
		input,
		context: contextAt(now),
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

const WEEK = [
	"月曜日: 11:00～22:00",
	"火曜日: 11:00～22:00",
	"水曜日: 定休日",
	"木曜日: 11:00～22:00",
	"金曜日: 11:00～23:00",
	"土曜日: 11:00～23:00",
	"日曜日: 11:00～21:00",
];

const place = (over: Record<string, unknown> = {}) => ({
	id: "p1",
	displayName: { text: "麦とラーメン", languageCode: "ja" },
	formattedAddress: "日本、大阪府枚方市楠葉花園町",
	businessStatus: "OPERATIONAL",
	currentOpeningHours: { openNow: true, weekdayDescriptions: WEEK },
	...over,
});

describe("place_search", () => {
	it("道具は place_search だけ", () => {
		expect(setup([]).adapter.tools).toEqual([placeSearch]);
	});

	it("営業中の店を返し、リクエストの URL・ヘッダー・本文が仕様どおり", async () => {
		const { adapter, calls } = setup([json({ places: [place()] })]);
		const out = successOf(await search(adapter, { query: "  くずは 麦  " }));

		expect(out.data).toEqual({
			places: [
				{
					name: "麦とラーメン",
					address: "日本、大阪府枚方市楠葉花園町",
					business_status: "OPERATIONAL",
					open_now: true,
					today_hours: "土曜日: 11:00～23:00",
				},
			],
		});
		const [call] = calls;
		expect(call?.url.href).toBe(
			"https://places.googleapis.com/v1/places:searchText",
		);
		expect(call?.init.method).toBe("POST");
		const headers = new Headers(call?.init.headers);
		expect(headers.get("x-goog-api-key")).toBe("key-1");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("x-goog-fieldmask")).toBe(
			"places.id,places.displayName,places.formattedAddress,places.businessStatus,places.currentOpeningHours",
		);
		expect(JSON.parse(String(call?.init.body))).toEqual({
			textQuery: "くずは 麦",
			languageCode: "ja",
			regionCode: "JP",
			pageSize: 3,
		});
	});

	it("営業時間外の店は open_now が false", async () => {
		const { adapter } = setup([
			json({
				places: [
					place({
						currentOpeningHours: { openNow: false, weekdayDescriptions: WEEK },
					}),
				],
			}),
		]);
		const out = successOf(await search(adapter));
		expect(out.data).toMatchObject({ places: [{ open_now: false }] });
	});

	it("候補がなければ（places が無い応答）空の一覧", async () => {
		const { adapter } = setup([json({})]);
		const out = successOf(await search(adapter));
		expect(out.data).toEqual({ places: [] });
	});

	it("複数の候補をそのまま並べ、3 件までに切る", async () => {
		const many = [1, 2, 3, 4].map((i) =>
			place({ displayName: { text: `店${i}` } }),
		);
		const { adapter } = setup([json({ places: many })]);
		const out = successOf(await search(adapter));
		expect(
			(out.data as { places: { name: string }[] }).places.map((p) => p.name),
		).toEqual(["店1", "店2", "店3"]);
	});

	it("営業時間を持たない場所は open_now と today_hours が null", async () => {
		const { adapter } = setup([
			json({ places: [place({ currentOpeningHours: undefined })] }),
		]);
		const out = successOf(await search(adapter));
		expect(out.data).toMatchObject({
			places: [{ open_now: null, today_hours: null }],
		});
	});

	it("今日の営業時間は JST の曜日で選ぶ（UTC の日曜 16:00 は JST の月曜）", async () => {
		const { adapter } = setup([
			json({ places: [place()] }),
			json({ places: [place()] }),
		]);
		const monday = successOf(
			await search(adapter, undefined, new Date("2026-10-18T16:00:00Z")),
		);
		expect(monday.data).toMatchObject({
			places: [{ today_hours: "月曜日: 11:00～22:00" }],
		});
		const sunday = successOf(
			await search(adapter, undefined, new Date("2026-10-18T14:59:00Z")),
		);
		expect(sunday.data).toMatchObject({
			places: [{ today_hours: "日曜日: 11:00～21:00" }],
		});
	});

	it("summary に場所の情報を含めない", async () => {
		const { adapter } = setup([json({ places: [place()] })]);
		const out = successOf(await search(adapter));
		expect(out.summary).not.toContain("麦とラーメン");
		expect(out.summary).not.toContain("枚方");
	});

	it("2xx 以外は ExternalServiceUnavailable（5xx は再試行可、4xx は不可）", async () => {
		const { adapter } = setup([json({}, 500), json({}, 403)]);
		const serverError = errorOf(await search(adapter));
		expect(serverError.type).toBe("ExternalServiceUnavailable");
		expect(serverError.retryable).toBe(true);
		const forbidden = errorOf(await search(adapter));
		expect(forbidden.type).toBe("ExternalServiceUnavailable");
		expect(forbidden.retryable).toBe(false);
	});

	it("429 は RateLimited", async () => {
		const { adapter } = setup([json({}, 429)]);
		expect(errorOf(await search(adapter)).type).toBe("RateLimited");
	});

	it("応答が想定と違えば ExternalServiceUnavailable", async () => {
		const { adapter } = setup([
			json({ places: "none" }),
			new Response("not json"),
		]);
		expect(errorOf(await search(adapter)).type).toBe(
			"ExternalServiceUnavailable",
		);
		expect(errorOf(await search(adapter)).type).toBe(
			"ExternalServiceUnavailable",
		);
	});

	it("接続できない・タイムアウトも ExternalServiceUnavailable", async () => {
		const { adapter } = setup([new TypeError("fetch failed"), "hang"], 10);
		expect(errorOf(await search(adapter)).type).toBe(
			"ExternalServiceUnavailable",
		);
		const timeout = errorOf(await search(adapter));
		expect(timeout.type).toBe("ExternalServiceUnavailable");
		expect(timeout.message).toContain("タイムアウト");
	});

	it("入力が不正なら fetch せずに ValidationFailed", async () => {
		const { adapter, calls } = setup([]);
		for (const input of [{}, { query: "   " }, { query: "あ".repeat(101) }]) {
			expect(errorOf(await search(adapter, input)).type).toBe(
				"ValidationFailed",
			);
		}
		expect(calls).toHaveLength(0);
	});
});
