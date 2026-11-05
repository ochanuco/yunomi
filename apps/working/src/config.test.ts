import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const base = {
	HOME: "/home/w",
	DISCORD_TOKEN: "t",
	WORKING_TOKEN: "shared",
	WORK_TEXT_CHANNEL_ID: "100",
	WORK_FORUM_CHANNEL_ID: "200",
	WORKING_OWNER_DISCORD_USER_IDS: "300, 400,",
};

describe("loadConfig", () => {
	it("最小構成を受理し、既定値を HOME から補う", () => {
		expect(loadConfig(base)).toEqual({
			ok: true,
			value: {
				discordToken: "t",
				sharedToken: "shared",
				workTextChannelId: "100",
				workForumChannelId: "200",
				ownerUserIds: new Set(["300", "400"]),
				port: 8080,
				stateDir: "/home/w/state",
				workDir: "/home/w/work",
				personaScript: "/home/w/bin/persona.sh",
				handoffDir: "/home/w/handoff",
				claudeBin: "claude",
				claudeTimeoutMs: 1_800_000,
				logLevel: "info",
			},
		});
	});

	it("数値の設定を読み、空文字は未設定として扱う", () => {
		const r = loadConfig({ ...base, PORT: "9000", CLAUDE_TIMEOUT_MS: "" });
		expect(r.ok && r.value.port).toBe(9000);
		expect(r.ok && r.value.claudeTimeoutMs).toBe(1_800_000);
		expect(loadConfig({ ...base, PORT: "x" }).ok).toBe(false);
	});

	it("トークンとチャンネル ID が欠けていれば理由を返す", () => {
		const r = loadConfig({ DISCORD_TOKEN: "t" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error.join("\n")).toContain("WORK_FORUM_CHANNEL_ID");
		expect(!r.ok && r.error.join("\n")).toContain(
			"WORKING_OWNER_DISCORD_USER_IDS",
		);
	});
});
