import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { openApprovalStore } from "./approval-store.ts";
import { claudeEnv, createClaudeCli, WORK_POLICY } from "./claude-cli.ts";
import { loadConfig } from "./config.ts";
import { createDiscordRest } from "./discord-rest.ts";
import { guardDirOf } from "./guard/env.ts";
import { createLedger } from "./guard/ledger.ts";
import { createIntake } from "./intake.ts";
import { createLogger } from "./logger.ts";
import { buildSystemPrompt } from "./prompts.ts";
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
await writeFile(
	systemPromptFile,
	buildSystemPrompt({
		persona: persona.stdout,
		handoffPrompt: await readFile(join(cfg.handoffDir, "prompt.md"), "utf8"),
		issueTemplate: await readFile(
			join(cfg.handoffDir, "issue-template.md"),
			"utf8",
		),
	}),
);

const discord = createDiscordRest({ token: cfg.discordToken, logger });
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
		policy: WORK_POLICY,
		env: claudeEnv(process.env, {
			workDir: cfg.workDir,
			stateDir: cfg.stateDir,
		}),
	}),
	sessions: await openSessionStore(cfg.stateDir),
	approvals: await openApprovalStore(cfg.stateDir),
	ledger: createLedger(guardDirOf(cfg.stateDir)),
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
