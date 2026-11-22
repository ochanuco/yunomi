import { describe, expect, it } from "vitest";
import { configWarnings, loadConfig } from "./config.ts";

const base = { DISCORD_TOKEN: "t", YUNOMI_URL: "http://localhost:8787/" };

describe("loadConfig", () => {
	it("最小構成を受理し、既定値を補う", () => {
		const r = loadConfig(base);
		expect(r).toEqual({
			ok: true,
			value: {
				discordToken: "t",
				partnerId: "yukarin",
				yunomiUrl: "http://localhost:8787",
				access: null,
				devCaller: false,
				avatarDir: null,
				workCategoryIds: new Set(),
				seatStatus: null,
				logLevel: "info",
			},
		});
	});

	it("VC の設定が配置側に残っていても、読み捨てて起動する", () => {
		const r = loadConfig({
			...base,
			RELAY_VOICE: "off",
			OCHOKO_URL: "http://192.168.10.253:8190",
			KUKICHA_URL: "not a url",
			OWNER_DISCORD_USER_ID: "42",
		});
		expect(r).toEqual(loadConfig(base));
		expect(loadConfig({ ...base, RELAY_VOICE: "garbage" }).ok).toBe(true);
	});

	it("PARTNER_ID は名簿の ID だけを受け付ける", () => {
		const r = loadConfig({ ...base, PARTNER_ID: "akarin" });
		expect(r.ok && r.value.partnerId).toBe("akarin");
		expect(loadConfig({ ...base, PARTNER_ID: "nobody" }).ok).toBe(false);
	});

	it("Access 認証と dev caller を読む", () => {
		const r = loadConfig({
			...base,
			CF_ACCESS_CLIENT_ID: "i",
			CF_ACCESS_CLIENT_SECRET: "s",
			YUNOMI_DEV_CALLER: "1",
			AVATAR_DIR: "/srv/avatars",
			LOG_LEVEL: "debug",
		});
		expect(r.ok && r.value).toMatchObject({
			access: { clientId: "i", clientSecret: "s" },
			devCaller: true,
			avatarDir: "/srv/avatars",
			logLevel: "debug",
		});
	});

	it("必須の欠落をまとめて報告する", () => {
		const r = loadConfig({});
		expect(!r.ok && r.error.join("\n")).toMatch(/DISCORD_TOKEN/);
		expect(!r.ok && r.error.join("\n")).toMatch(/YUNOMI_URL/);
	});

	it("空文字は未設定扱い", () => {
		expect(loadConfig({ ...base, DISCORD_TOKEN: "" }).ok).toBe(false);
	});

	it("不正な URL・LOG_LEVEL・片方だけの Access を拒否する", () => {
		expect(loadConfig({ ...base, YUNOMI_URL: "nope" }).ok).toBe(false);
		expect(loadConfig({ ...base, LOG_LEVEL: "loud" }).ok).toBe(false);
		expect(loadConfig({ ...base, CF_ACCESS_CLIENT_ID: "i" }).ok).toBe(false);
	});

	it("仕事カテゴリはカンマ区切りで読む", () => {
		const r = loadConfig({ ...base, WORK_CATEGORY_IDS: "10, 20,," });
		expect(r.ok && r.value.workCategoryIds).toEqual(new Set(["10", "20"]));
	});

	it("席の状態を渡す口は URL とトークンをそろえて読む", () => {
		const r = loadConfig({
			...base,
			SEAT_STATUS_URL: "http://working.example:8191",
			SEAT_STATUS_TOKEN: "seat",
		});
		expect(r.ok && r.value.seatStatus).toEqual({
			url: "http://working.example:8191",
			token: "seat",
		});
		expect(
			loadConfig({ ...base, SEAT_STATUS_URL: "http://working.example" }).ok,
		).toBe(false);
	});
});

describe("configWarnings", () => {
	const load = (env: Record<string, string>) => {
		const r = loadConfig({ ...base, ...env });
		if (!r.ok) throw new Error(r.error.join());
		return r.value;
	};

	it("WORK_CATEGORY_IDS が未設定なら、仕事カテゴリが除外されないことを警告する", () => {
		expect(configWarnings(load({}))).toEqual([
			"WORK_CATEGORY_IDS is not set; messages in work categories are sent to the Worker",
		]);
	});

	it("仕事カテゴリがあれば警告しない", () => {
		expect(configWarnings(load({ WORK_CATEGORY_IDS: "1,2" }))).toEqual([]);
	});
});
