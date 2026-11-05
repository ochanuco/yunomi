import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createClaudeCli, READ_ONLY_POLICY } from "./claude-cli.ts";
import { loadConfig } from "./config.ts";
import { createDiscordRest } from "./discord-rest.ts";
import { createIntake } from "./intake.ts";
import { createLogger } from "./logger.ts";
import { WORKING_INSTRUCTIONS } from "./prompts.ts";
import { createWorkingServer } from "./server.ts";
import { openSessionStore } from "./session-store.ts";

const config = loadConfig(process.env);
if (!config.ok) {
	console.error("設定が不正です:");
	for (const issue of config.error) console.error(`  - ${issue}`);
	process.exit(1);
}
const cfg = config.value;
const logger = createLogger(cfg.logLevel);

const persona = await promisify(execFile)(cfg.personaScript, {
	maxBuffer: 10_000_000,
});
const systemPromptFile = join(cfg.stateDir, "system-prompt.md");
await mkdir(cfg.stateDir, { recursive: true });
await mkdir(cfg.workDir, { recursive: true });
await writeFile(systemPromptFile, `${persona.stdout}\n${WORKING_INSTRUCTIONS}`);

const discord = createDiscordRest({ token: cfg.discordToken });
const me = await discord.me();
if (!me.ok) {
	logger.error("discord login failed", { error: me.error.type });
	process.exit(1);
}

const intake = createIntake({
	discord,
	claude: createClaudeCli({
		bin: cfg.claudeBin,
		cwd: cfg.workDir,
		systemPromptFile,
		timeoutMs: cfg.claudeTimeoutMs,
		policy: READ_ONLY_POLICY,
	}),
	sessions: await openSessionStore(cfg.stateDir),
	botUserId: me.value.id,
	workTextChannelId: cfg.workTextChannelId,
	workForumChannelId: cfg.workForumChannelId,
	ownerUserIds: cfg.ownerUserIds,
	newSessionId: randomUUID,
	logger,
});

const server = createWorkingServer({
	sharedToken: cfg.sharedToken,
	accept: (envelope) => {
		void intake.handle(envelope).catch((e: unknown) => {
			logger.error("intake crashed", {
				event_id: envelope.event_id,
				error: String(e),
			});
		});
	},
	logger,
});
server.listen(cfg.port, () => {
	logger.info("working intake ready", {
		port: cfg.port,
		bot_user_id: me.value.id,
	});
});

const shutdown = (signal: string) => {
	logger.info("shutting down", { signal });
	server.close();
	process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
