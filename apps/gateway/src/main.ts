import { generateDependencyReport } from "@discordjs/voice";
import { Client, Events, GatewayIntentBits } from "discord.js";
import { DEFAULT_AVATAR_DIR, loadAvatarStock } from "./avatar-stock.ts";
import { loadConfig } from "./config.ts";
import {
	countHumans,
	isRelayable,
	toMessageLike,
	toVoiceStateLike,
} from "./discord-adapter.ts";
import { createEars } from "./ears.ts";
import { createMessageHandler } from "./handler.ts";
import { createHearing } from "./hearing.ts";
import { DEFAULT_HEARTBEAT_PATH, startHeartbeat } from "./heartbeat.ts";
import { createKukichaClient } from "./kukicha-client.ts";
import { createLogger } from "./logger.ts";
import { createOchokoClient } from "./ochoko-client.ts";
import { VoiceManager } from "./voice-manager.ts";
import { createVoiceStateHandler } from "./voice-state.ts";
import { YunomiClient } from "./yunomi-client.ts";

const PARTNER_ID = "yukarin";

const config = loadConfig(process.env);
if (!config.ok) {
	console.error("設定が不正です:");
	for (const issue of config.error) console.error(`  - ${issue}`);
	process.exit(1);
}
const cfg = config.value;
const logger = createLogger(cfg.logLevel);
if (cfg.kukicha && !cfg.ownerUserId) {
	logger.warn(
		"KUKICHA_URL is set but OWNER_DISCORD_USER_ID is not; not listening",
	);
}

const avatarDir = cfg.avatarDir ?? DEFAULT_AVATAR_DIR;
const avatars = await loadAvatarStock(avatarDir);
if (avatars.count() === 0) {
	logger.warn("no avatar images", { dir: avatarDir });
} else {
	logger.info("avatar images loaded", { count: avatars.count() });
}

const discord = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.MessageContent,
	],
});

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
				partnerId: PARTNER_ID,
				ownerUserId: cfg.ownerUserId,
				displayNameOf: (guildId, userId) =>
					discord.guilds.cache.get(guildId)?.members.cache.get(userId)
						?.displayName ?? null,
				channelOf: (channelId) => {
					const channel = discord.channels.cache.get(channelId);
					return channel?.isSendable() ? channel : null;
				},
				// VoiceManager は耳を受け取るので後で作る。発話が届く時点では作られている
				voice: { apply: (d) => voice.apply(d) },
				connectedChannelOf: (guildId) => voice.channelOf(guildId),
				avatars,
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
	partnerId: PARTNER_ID,
	ochoko,
	yunomi,
	ears,
	adapterCreator: (guildId) =>
		discord.guilds.cache.get(guildId)?.voiceAdapterCreator ?? null,
	logger,
});

const handleVoiceState = createVoiceStateHandler({
	client: yunomi,
	voice,
	partnerId: PARTNER_ID,
	get botUserId() {
		return discord.user?.id ?? "";
	},
	countHumans: (guildId, channelId) =>
		countHumans(discord.guilds.cache.get(guildId), channelId),
	logger,
});

discord.once(Events.ClientReady, (c) => {
	logger.info("gateway ready", { bot_user_id: c.user.id });
	logger.debug("voice dependencies", { report: generateDependencyReport() });
	// 前回の接続先を Worker が覚えたままにしない
	void voice.reportStartup([...c.guilds.cache.keys()]);
	startHeartbeat({
		path: process.env.HEARTBEAT_FILE ?? DEFAULT_HEARTBEAT_PATH,
		isReady: () => discord.isReady(),
	});
});

discord.on(Events.MessageCreate, (message) => {
	const botUserId = discord.user?.id;
	if (!botUserId || message.author.id === botUserId) return;
	if (!isRelayable(message)) return;
	const channel = message.channel;
	const handle = createMessageHandler({
		client: yunomi,
		partnerId: PARTNER_ID,
		botUserId,
		voice,
		avatars,
		logger,
	});
	void handle(toMessageLike(message), {
		// 送る時点の値を読むので getter にする
		get lastMessageId() {
			return channel.lastMessageId;
		},
		send: (options) => channel.send(options),
	}).catch((e: unknown) => {
		logger.error("handler crashed", { error: String(e) });
	});
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
