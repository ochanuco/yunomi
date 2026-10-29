import type { DomainError, Result } from "@yunomi/core";
import { toModelJson } from "@yunomi/core";
import { describe, expect, it } from "vitest";
import type { CallContext, CapabilityResponse } from "../contract.ts";
import { homeState } from "../definitions/home.ts";
import {
	createHomeAssistantAdapter,
	parseHomeEntityIds,
} from "./home-assistant.ts";

type Call = { url: URL; init: RequestInit };
type Step = Response | Error;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const ENTITIES = ["person.owner", "sensor.phone_battery_level", "weather.home"];

// 並行に呼ぶので、応答は呼び出し順ではなく entity ID で引く。
const setup = (
	steps: Record<string, Step>,
	entityIds: readonly string[] = ENTITIES,
) => {
	const calls: Call[] = [];
	const fetchFn = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = new URL(String(input));
		calls.push({ url, init: init ?? {} });
		const id = decodeURIComponent(url.pathname.replace("/api/states/", ""));
		const step = steps[id];
		if (step === undefined) throw new Error(`想定外の fetch: ${id}`);
		if (step instanceof Error) throw step;
		return step;
	}) as typeof fetch;
	const adapter = createHomeAssistantAdapter({
		fetch: fetchFn,
		baseUrl: "https://ha.example.test/",
		token: "tok-1",
		entityIds,
	});
	return { adapter, calls };
};

const context: CallContext = {
	partnerId: "partner-1",
	speakerId: "speaker-1",
	isOwner: true,
	channelId: "channel-1",
	sourceMessageId: "1234567890123456789",
	now: new Date("2026-10-30T03:00:00Z"),
};

const read = (
	adapter: ReturnType<typeof setup>["adapter"],
	input: unknown = {},
) =>
	adapter.execute({
		requestId: "req-1",
		tool: homeState.name,
		input,
		context,
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

const person = () =>
	json({
		entity_id: "person.owner",
		state: "not_home",
		attributes: {
			friendly_name: "オーナー",
			latitude: 34.8,
			longitude: 135.6,
			gps_accuracy: 12,
			source: "device_tracker.phone",
		},
		last_changed: "2026-10-30T01:15:00+00:00",
	});

const battery = () =>
	json({
		entity_id: "sensor.phone_battery_level",
		state: "45",
		attributes: {
			friendly_name: "Phone Battery level",
			unit_of_measurement: "%",
			device_class: "battery",
		},
		last_changed: "2026-10-30T02:50:00+00:00",
	});

const weather = () =>
	json({
		entity_id: "weather.home",
		state: "cloudy",
		attributes: {
			friendly_name: "Forecast 自宅",
			temperature: 13.7,
			temperature_unit: "°C",
			humidity: 72,
			pressure: 1013,
			wind_speed: 9.4,
		},
		last_changed: "2026-10-30T02:00:00+00:00",
	});

const allFound = () => ({
	"person.owner": person(),
	"sensor.phone_battery_level": battery(),
	"weather.home": weather(),
});

describe("home_state", () => {
	it("道具は home_state だけ", () => {
		expect(setup({}).adapter.tools).toEqual([homeState]);
	});

	it("設定した entity を返し、リクエストの URL とヘッダーが仕様どおり", async () => {
		const { adapter, calls } = setup(allFound());
		const out = successOf(await read(adapter));

		expect(out.data).toEqual({
			entities: [
				{
					entity_id: "person.owner",
					name: "オーナー",
					state: "not_home",
					unit: null,
					last_changed: new Date("2026-10-30T01:15:00Z"),
				},
				{
					entity_id: "sensor.phone_battery_level",
					name: "Phone Battery level",
					state: "45",
					unit: "%",
					last_changed: new Date("2026-10-30T02:50:00Z"),
				},
				{
					entity_id: "weather.home",
					name: "Forecast 自宅",
					state: "cloudy",
					unit: null,
					last_changed: new Date("2026-10-30T02:00:00Z"),
					temperature: 13.7,
					temperature_unit: "°C",
					humidity: 72,
				},
			],
			missing: [],
		});
		expect(calls.map((c) => c.url.href)).toEqual([
			"https://ha.example.test/api/states/person.owner",
			"https://ha.example.test/api/states/sensor.phone_battery_level",
			"https://ha.example.test/api/states/weather.home",
		]);
		for (const call of calls) {
			expect(call.init.method).toBe("GET");
			const headers = new Headers(call.init.headers);
			expect(headers.get("authorization")).toBe("Bearer tok-1");
		}
	});

	it("person の緯度・経度などの属性はモデルに渡らない", async () => {
		const { adapter } = setup(allFound());
		const model = toModelJson(successOf(await read(adapter)).data);
		for (const key of ["latitude", "longitude", "gps_accuracy", "source"]) {
			expect(model).not.toContain(key);
		}
		expect(model).not.toContain("34.8");
	});

	it("weather 以外には気温と湿度の項目を付けない", async () => {
		const { adapter } = setup(allFound());
		const out = successOf(await read(adapter));
		const [p, b] = (out.data as { entities: object[] }).entities;
		expect(p).not.toHaveProperty("temperature");
		expect(b).not.toHaveProperty("humidity");
	});

	it("weather に気温や湿度がなければ null", async () => {
		const { adapter } = setup(
			{
				"weather.home": json({
					entity_id: "weather.home",
					state: "sunny",
					attributes: { temperature: "13.7" },
					last_changed: "2026-10-30T02:00:00+00:00",
				}),
			},
			["weather.home"],
		);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({
			entities: [{ temperature: null, temperature_unit: null, humidity: null }],
		});
	});

	it("住所センサーは町名までに切り詰め、番地や郵便番号を返さない", async () => {
		const { adapter } = setup(
			{
				"sensor.phone_geocoded_location": json({
					entity_id: "sensor.phone_geocoded_location",
					state: "日本、〒100-0001 東京都千代田区千代田１丁目１−１",
					attributes: {
						administrative_area: "東京都",
						locality: "千代田区",
						thoroughfare: "１丁目",
						postal_code: "100-0001",
						iso_country_code: "JP",
						location: [35.68, 139.75],
					},
					last_changed: "2026-10-30T02:00:00+00:00",
				}),
			},
			["sensor.phone_geocoded_location"],
		);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({
			entities: [{ state: "東京都千代田区千代田" }],
		});
		const model = toModelJson(out.data);
		for (const leak of ["１丁目", "100-0001", "35.68", "〒"]) {
			expect(model).not.toContain(leak);
		}
	});

	it.each([
		[
			"町名の後に数字がなければ、市区町村の後ろを全部",
			"東京都千代田区丸の内",
			"東京都千代田区丸の内",
		],
		[
			"住所に市区町村が見つからなければ市区町村まで",
			"Somewhere 1-1",
			"東京都千代田区",
		],
	])("住所センサー: %s", async (_, address, expected) => {
		const { adapter } = setup(
			{
				"sensor.phone_geocoded_location": json({
					entity_id: "sensor.phone_geocoded_location",
					state: address,
					attributes: {
						administrative_area: "東京都",
						locality: "千代田区",
						iso_country_code: "JP",
					},
					last_changed: "2026-10-30T02:00:00+00:00",
				}),
			},
			["sensor.phone_geocoded_location"],
		);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({ entities: [{ state: expected }] });
	});

	it("住所センサーに市区町村の属性がなければ state は null", async () => {
		const { adapter } = setup(
			{
				"sensor.phone_geocoded_location": json({
					entity_id: "sensor.phone_geocoded_location",
					state: "日本、〒100-0001 東京都千代田区千代田１丁目１−１",
					attributes: { iso_country_code: "JP" },
					last_changed: "2026-10-30T02:00:00+00:00",
				}),
			},
			["sensor.phone_geocoded_location"],
		);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({ entities: [{ state: null }] });
	});

	it("timestamp の state はモデルに JST の書式で渡る", async () => {
		const { adapter } = setup(
			{
				"sensor.phone_next_alarm": json({
					entity_id: "sensor.phone_next_alarm",
					state: "2026-10-29T22:30:00+00:00",
					attributes: { device_class: "timestamp" },
					last_changed: "2026-10-29T13:00:00+00:00",
				}),
			},
			["sensor.phone_next_alarm"],
		);
		const model = JSON.parse(toModelJson(successOf(await read(adapter)).data));
		expect(model.entities[0].state).toBe("2026-10-30 07:30 JST");
	});

	it("timestamp でも日時として読めなければ state はそのまま", async () => {
		const { adapter } = setup(
			{
				"sensor.phone_next_alarm": json({
					entity_id: "sensor.phone_next_alarm",
					state: "unavailable",
					attributes: { device_class: "timestamp" },
					last_changed: "2026-10-29T13:00:00+00:00",
				}),
			},
			["sensor.phone_next_alarm"],
		);
		const out = successOf(await read(adapter));
		expect(out.data).toMatchObject({ entities: [{ state: "unavailable" }] });
	});

	it("日時はモデルに JST の書式で渡る", async () => {
		const { adapter } = setup(allFound());
		const model = JSON.parse(toModelJson(successOf(await read(adapter)).data));
		expect(model.entities[0].last_changed).toBe("2026-10-30 10:15 JST");
	});

	it("404 の entity は外し、外した ID を返す", async () => {
		const { adapter } = setup({
			...allFound(),
			"sensor.phone_battery_level": json({ message: "Entity not found." }, 404),
		});
		const out = successOf(await read(adapter));
		const data = out.data as { entities: { entity_id: string }[] };
		expect(data.entities.map((e) => e.entity_id)).toEqual([
			"person.owner",
			"weather.home",
		]);
		expect(out.data).toMatchObject({
			missing: ["sensor.phone_battery_level"],
		});
	});

	it("全部が 404 なら retryable ではない ExternalServiceUnavailable", async () => {
		const notFound = () => json({ message: "Entity not found." }, 404);
		const { adapter } = setup({
			"person.owner": notFound(),
			"sensor.phone_battery_level": notFound(),
			"weather.home": notFound(),
		});
		const e = errorOf(await read(adapter));
		expect(e.type).toBe("ExternalServiceUnavailable");
		expect(e.retryable).toBe(false);
	});

	it.each([
		[401, false],
		[403, false],
		[500, true],
		[502, true],
	])(
		"%i は ExternalServiceUnavailable（retryable: %s）",
		async (status, retryable) => {
			const { adapter } = setup({
				...allFound(),
				"weather.home": json({ message: "x" }, status),
			});
			const e = errorOf(await read(adapter));
			expect(e.type).toBe("ExternalServiceUnavailable");
			expect(e.message).toContain(String(status));
			expect(e.retryable).toBe(retryable);
		},
	);

	it("タイムアウトは retryable な ExternalServiceUnavailable", async () => {
		const timeout = new DOMException("timed out", "TimeoutError");
		const { adapter } = setup({ ...allFound(), "person.owner": timeout });
		const e = errorOf(await read(adapter));
		expect(e.type).toBe("ExternalServiceUnavailable");
		expect(e.message).toContain("タイムアウト");
		expect(e.retryable).toBe(true);
	});

	it("ネットワーク失敗は retryable な ExternalServiceUnavailable", async () => {
		const { adapter } = setup({
			...allFound(),
			"person.owner": new TypeError("fetch failed"),
		});
		const e = errorOf(await read(adapter));
		expect(e.type).toBe("ExternalServiceUnavailable");
		expect(e.retryable).toBe(true);
	});

	it("応答が想定と違えば ExternalServiceUnavailable", async () => {
		const { adapter } = setup({
			...allFound(),
			"weather.home": json({ unexpected: true }),
		});
		expect(errorOf(await read(adapter)).type).toBe(
			"ExternalServiceUnavailable",
		);
	});

	it("summary は件数だけで、state を含まない", async () => {
		const { adapter } = setup({
			...allFound(),
			"weather.home": json({ message: "Entity not found." }, 404),
		});
		const out = successOf(await read(adapter));
		expect(out.summary).toBe("entity 2 件を取得、1 件は見つからない");
		expect(out.summary).not.toContain("not_home");
	});

	it("入力に余計な項目があっても読む", async () => {
		const { adapter } = setup(allFound());
		expect((await read(adapter, { entity_id: "device_tracker.x" })).ok).toBe(
			true,
		);
	});

	it("未知の道具は ValidationFailed", async () => {
		const { adapter } = setup({});
		const r = await adapter.execute({
			requestId: "req-1",
			tool: "other",
			input: {},
			context,
		});
		expect(errorOf(r).type).toBe("ValidationFailed");
	});
});

describe("parseHomeEntityIds", () => {
	it("カンマで分けて前後の空白を落とす", () => {
		expect(parseHomeEntityIds(" person.owner, weather.home ,")).toEqual([
			"person.owner",
			"weather.home",
		]);
	});

	it("entity ID の形でないものは捨てる", () => {
		expect(
			parseHomeEntityIds("person.owner,../config,weather,Sensor.X,a.b/c"),
		).toEqual(["person.owner"]);
	});

	it("空文字なら空", () => {
		expect(parseHomeEntityIds("")).toEqual([]);
	});
});
