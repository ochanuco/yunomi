import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { openApprovalStore } from "./approval-store.ts";
import {
	createAttachmentCollector,
	createChimeraImages,
} from "./attachments.ts";
import { childEnv, createSummarizer } from "./claude-cli.ts";
import { claudeConfigPathOf, trustWorkspace } from "./claude-trust.ts";
import { loadConfig } from "./config.ts";
import { createDiscordRest } from "./discord-rest.ts";
import { spawnExec } from "./exec.ts";
import { guardDirOf } from "./guard/env.ts";
import { createLedger } from "./guard/ledger.ts";
import { createIntake } from "./intake.ts";
import { createLogger } from "./logger.ts";
import { createMacStateServer, openMacStateStore } from "./mac-state.ts";
import { credentialsPathOf } from "./memory-cli/cli.ts";
import { createOrcaCli } from "./orca.ts";
import { buildSeatPreamble } from "./prompts.ts";
import { startRepoMapSync } from "./repo-map/sync.ts";
import { openSeatStore } from "./seat-store.ts";
import { createWorkingServer } from "./server.ts";
import { finishStandup, startStandup } from "./standup.ts";
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
await mkdir(cfg.stateDir, { recursive: true });
await mkdir(cfg.workDir, { recursive: true });
const preamble = buildSeatPreamble({
	persona: persona.stdout,
	handoffPrompt: await readFile(join(cfg.handoffDir, "prompt.md"), "utf8"),
	issueTemplate: await readFile(
		join(cfg.handoffDir, "issue-template.md"),
		"utf8",
	),
});

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

const env = childEnv(process.env, cfg.stateDir);
const summarize = createSummarizer({
	bin: cfg.claudeBin,
	cwd: cfg.workDir,
	env,
	exec: spawnExec,
});
const orca = createOrcaCli({
	bin: cfg.orcaBin,
	exec: spawnExec,
	env,
	cwd: cfg.workDir,
	seatsRepo: cfg.seatsRepo,
	seatsDir: cfg.seatsDir,
	specDir: join(cfg.stateDir, "specs"),
	trust: (dir) => trustWorkspace(claudeConfigPathOf(process.env), dir),
	logger,
});
const ORCA_READY_TIMEOUT_MS = 180_000;
const seats = await openSeatStore(cfg.stateDir);
const approvals = await openApprovalStore(cfg.stateDir);
const ledger = createLedger(guardDirOf(cfg.stateDir));
const macState = openMacStateStore(cfg.stateDir);
const standupDeps = {
	discord,
	approvals,
	ledger,
	workForumChannelId: cfg.workForumChannelId,
	logger,
};

// start.sh は受付と orca serve を同時に起動するので、serve が受け付けるまで待ってから席の準備をする
logger.info("discord connected", { bot_user_id: me.value.id });
const ready = await orca.waitReady(ORCA_READY_TIMEOUT_MS);
if (!ready.ok) {
	logger.error("orca serve not ready", { reason: ready.error.reason });
	process.exit(1);
}
logger.info("orca serve ready");
const prepared = await orca.prepare(seats.orca());
if (!prepared.ok) {
	logger.error("orca prepare failed", { reason: prepared.error.reason });
	process.exit(1);
}
await seats.setOrca(prepared.value);
logger.info("orca prepared", { run_id: prepared.value.runId });

if (!cfg.chimera) {
	logger.warn("chimera images disabled", {
		reason:
			"CHIMERA_URL / CHIMERA_ACCESS_CLIENT_ID / CHIMERA_ACCESS_CLIENT_SECRET",
	});
}
// chimera の service token は受付だけが持つ。席の Claude には seat-env.sh が渡さない
const collectAttachments = createAttachmentCollector({
	chimera: cfg.chimera
		? createChimeraImages({
				baseUrl: cfg.chimera.url,
				clientId: cfg.chimera.clientId,
				clientSecret: cfg.chimera.clientSecret,
			})
		: null,
	logger,
});

const intake = createIntake({
	discord,
	orca,
	seats,
	approvals,
	ledger,
	summarize,
	collectAttachments,
	remember: async (summary) => {
		if (!cfg.memory) return;
		const out = await spawnExec(
			cfg.memoryBin,
			["write", "--kind", "done", "--summary", summary.slice(0, 200)],
			{ stdin: "", cwd: cfg.workDir, timeoutMs: 30_000, env },
		);
		if (out.code !== 0) {
			logger.warn("memory write failed", { stderr: out.stderr.slice(0, 300) });
		}
	},
	standupDone: async (text, blocked) => {
		await finishStandup(standupDeps, text, blocked);
	},
	preamble,
	botUserId: me.value.id,
	workTextChannelId: cfg.workTextChannelId,
	workForumChannelId: cfg.workForumChannelId,
	ownerUserIds: cfg.ownerUserIds,
	seatLimit: cfg.seatLimit,
	sleepAfterMs: cfg.seatSleepAfterMs,
	logger,
});
await intake.reconcile();
logger.info("seats reconciled", { seats: seats.all().length });

// 席からのメッセージを待ち続ける。受付が落ちている間に届いたものも、次の check で受け取れる
let stopped = false;
const MAIL_WAIT_MS = 10 * 60_000;
void (async () => {
	while (!stopped) {
		const r = await orca.waitMessages(MAIL_WAIT_MS);
		if (!r.ok) {
			logger.warn("seat mail check failed", { reason: r.error.reason });
			await new Promise((res) => setTimeout(res, 5_000));
			continue;
		}
		for (const msg of r.value) {
			void intake.onSeatMessage(msg).catch((e: unknown) => {
				logger.error("seat message crashed", { id: msg.id, error: String(e) });
			});
		}
	}
})();
const sleepTimer = setInterval(() => {
	void intake.sleepIdle().catch((e: unknown) => {
		logger.error("seat sleep crashed", { error: String(e) });
	});
	void intake.refreshPanels().catch((e: unknown) => {
		logger.error("seat panel refresh crashed", { error: String(e) });
	});
}, 60_000);

// 席の Claude の SessionStart hook は写しだけを読み、席を起動するたびに GitHub へ行かない
const REPO_MAP_SYNC_MS = 60 * 60_000;
const repoMapSync = startRepoMapSync({
	exec: spawnExec,
	env,
	cwd: cfg.workDir,
	stateDir: cfg.stateDir,
	logger,
	intervalMs: REPO_MAP_SYNC_MS,
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
	seatSummary: intake.summary,
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
				await startStandup({
					deps: standupDeps,
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
					preamble,
					start: intake.startStandup,
				});
			},
			logger,
		})
	: null;

const shutdown = (signal: string) => {
	logger.info("shutting down", { signal });
	stopped = true;
	clearInterval(sleepTimer);
	repoMapSync.stop();
	standupTimer?.stop();
	macStateServer?.close();
	server.close();
	process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
