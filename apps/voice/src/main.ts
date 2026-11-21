import { generateDependencyReport } from "@discordjs/voice";
import { Events } from "discord.js";
import { configWarnings, loadConfig } from "./config.ts";
import {
	countHumans,
	createDiscordClient,
	toVoiceStateLike,
} from "./discord.ts";
import { createEars } from "./ears.ts";
import { createHearing } from "./hearing.ts";
import { createKukichaClient } from "./kukicha-client.ts";
import { createLogger } from "./logger.ts";
import { createOchokoClient } from "./ochoko-client.ts";
import { VoiceManager } from "./voice-manager.ts";
import { createVoiceStateHandler } from "./voice-state.ts";
import { YunomiClient } from "./yunomi-client.ts";

const config = loadConfig(process.env);
if (!config.ok) {
	console.error("設定が不正です:");
	for (const issue of config.error) console.error(`  - ${issue}`);
	process.exit(1);
}
const cfg = config.value;
const logger = createLogger(cfg.logLevel);
for (const warning of configWarnings(cfg)) logger.warn(warning);

const discord = createDiscordClient();

const yunomi = new YunomiClient({
	baseUrl: cfg.yunomiUrl,
	access: cfg.access,
	devCaller: cfg.devCaller,
	logger,
});

const ochoko = cfg.ochoko
	? createOchokoClient({
			baseUrl: cfg.ochoko.url,
			token: cfg.ochoko.token,
			logger,
		})
	: null;

const kukicha = cfg.kukicha
	? createKukichaClient({
			baseUrl: cfg.kukicha.url,
			token: cfg.kukicha.token,
			logger,
		})
	: null;

const hear =
	cfg.ownerUserId && kukicha
		? createHearing({
				kukicha,
				client: yunomi,
				partnerId: cfg.partnerId,
				ownerUserId: cfg.ownerUserId,
				displayNameOf: (guildId, userId) =>
					discord.guilds.cache.get(guildId)?.members.cache.get(userId)
						?.displayName ?? null,
				// VoiceManager は耳を受け取るので後で作る。発話が届く時点では作られている
				voice: { apply: (d) => voice.apply(d) },
				connectedChannelOf: (guildId) => voice.channelOf(guildId),
				logger,
			})
		: null;

const ears = cfg.ownerUserId
	? createEars({
			ownerUserId: cfg.ownerUserId,
			onUtterance: (u, where) => {
				if (hear) {
					void hear(u, where);
					return;
				}
				logger.info("utterance heard", {
					guild_id: where.guildId,
					channel_id: where.channelId,
					duration_ms: u.durationMs,
				});
			},
			logger,
		})
	: null;

const voice = new VoiceManager({
	partnerId: cfg.partnerId,
	ochoko,
	yunomi,
	ears,
	listening: hear !== null,
	adapterCreator: (guildId) =>
		discord.guilds.cache.get(guildId)?.voiceAdapterCreator ?? null,
	logger,
});

const handleVoiceState = createVoiceStateHandler({
	client: yunomi,
	voice,
	partnerId: cfg.partnerId,
	get botUserId() {
		return discord.user?.id ?? "";
	},
	countHumans: (guildId, channelId) =>
		countHumans(discord.guilds.cache.get(guildId), channelId),
	logger,
});

discord.once(Events.ClientReady, (c) => {
	logger.info("voice ready", { bot_user_id: c.user.id });
	logger.debug("voice dependencies", { report: generateDependencyReport() });
	// 前回の接続先を Worker が覚えたままにしない
	void voice.reportStartup([...c.guilds.cache.keys()]);
});

discord.on(Events.VoiceStateUpdate, (oldState, newState) => {
	void handleVoiceState(
		toVoiceStateLike(oldState),
		toVoiceStateLike(newState),
	).catch((e: unknown) => {
		logger.error("voice handler crashed", { error: String(e) });
	});
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info("shutting down", { signal });
	await voice.shutdown();
	await discord.destroy();
	process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await discord.login(cfg.discordToken);
