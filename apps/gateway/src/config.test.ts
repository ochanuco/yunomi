import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const base = { DISCORD_TOKEN: "t", YUNOMI_URL: "http://localhost:8787/" };

describe("loadConfig", () => {
	it("最小構成を受理し、既定値を補う", () => {
		const r = loadConfig(base);
		expect(r).toEqual({
			ok: true,
			value: {
				discordToken: "t",
				yunomiUrl: "http://localhost:8787",
				access: null,
				ochoko: null,
				devCaller: false,
				avatarDir: null,
				logLevel: "info",
			},
		});
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

	it("OCHOKO_URL と AIVOICE_TOKEN は任意で、指定するなら両方そろえる", () => {
		const both = loadConfig({
			...base,
			OCHOKO_URL: "http://192.168.10.254:8190/",
			AIVOICE_TOKEN: "tok",
		});
		expect(both.ok && both.value.ochoko).toEqual({
			url: "http://192.168.10.254:8190",
			token: "tok",
		});
		expect(loadConfig({ ...base, OCHOKO_URL: "http://x:1" }).ok).toBe(false);
		expect(loadConfig({ ...base, AIVOICE_TOKEN: "tok" }).ok).toBe(false);
	});
});
