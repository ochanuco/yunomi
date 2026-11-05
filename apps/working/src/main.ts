import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { openApprovalStore } from "./approval-store.ts";
import {
	claudeEnv,
	createClaudeCli,
	spawnExec,
	WORK_POLICY,
} from "./claude-cli.ts";
import { loadConfig } from "./config.ts";
import { createDiscordRest } from "./discord-rest.ts";
import { guardDirOf } from "./guard/env.ts";
import { createLedger } from "./guard/ledger.ts";
import { createIntake } from "./intake.ts";
import { createLogger } from "./logger.ts";
import { createMacStateServer, openMacStateStore } from "./mac-state.ts";
import { credentialsPathOf } from "./memory-cli/cli.ts";
import { buildSystemPrompt } from "./prompts.ts";
import { createWorkingServer } from "./server.ts";
import { openSessionStore } from "./session-store.ts";
import { runStandup } from "./standup.ts";
import { gatherStandupMaterials } from "./standup-materials.ts";
import { startStandupTimer } from "./standup-timer.ts";

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

// yunomi-memory はこのファイルから接続情報を読む。Claude CLI の環境変数に service token を載せないため
const credentialsPath = credentialsPathOf(cfg.stateDir);
if (cfg.memory) {
	await writeFile(
		credentialsPath,
		JSON.stringify({
			url: cfg.memory.url,
			client_id: cfg.memory.clientId,
			client_secret: cfg.memory.clientSecret,
			discord_user_id: cfg.ownerDiscordUserId,
			partner_id: "yukarin",
		}),
		{ mode: 0o600 },
	);
} else {
	await rm(credentialsPath, { force: true });
	logger.warn("working memory disabled", {
		reason: "YUNOMI_URL / CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET",
	});
}

const discord = createDiscordRest({ token: cfg.discordToken, logger });
const me = await discord.me();
if (!me.ok) {
	logger.error("discord login failed", { error: me.error.type });
	process.exit(1);
}

const env = claudeEnv(process.env, {
	workDir: cfg.workDir,
	stateDir: cfg.stateDir,
});
const claude = createClaudeCli({
	bin: cfg.claudeBin,
	cwd: cfg.workDir,
	systemPromptFile,
	timeoutMs: cfg.claudeTimeoutMs,
	policy: WORK_POLICY,
	env,
});
const sessions = await openSessionStore(cfg.stateDir);
const approvals = await openApprovalStore(cfg.stateDir);
const ledger = createLedger(guardDirOf(cfg.stateDir));
const macState = openMacStateStore(cfg.stateDir);

const intake = createIntake({
	discord,
	claude,
	sessions,
	approvals,
	ledger,
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

const macStateServer = cfg.macState
	? createMacStateServer({ token: cfg.macState.token, store: macState, logger })
	: null;
if (cfg.macState && macStateServer) {
	const { port } = cfg.macState;
	macStateServer.listen(port, () => {
		logger.info("mac state intake ready", { port });
	});
}

const standupTimer = cfg.standup.enabled
	? startStandupTimer({
			at: cfg.standup.at,
			run: async () => {
				await runStandup({
					claude,
					discord,
					sessions,
					approvals,
					ledger,
					workForumChannelId: cfg.workForumChannelId,
					gather: () =>
						gatherStandupMaterials({
							exec: spawnExec,
							env,
							cwd: cfg.workDir,
							claudeBin: cfg.claudeBin,
							memoryBin: cfg.memoryBin,
							githubOwner: cfg.standup.githubOwner,
							macState,
							now: () => new Date(),
							logger,
						}),
					newSessionId: randomUUID,
					logger,
				});
			},
			logger,
		})
	: null;

const shutdown = (signal: string) => {
	logger.info("shutting down", { signal });
	standupTimer?.stop();
	macStateServer?.close();
	server.close();
	process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
