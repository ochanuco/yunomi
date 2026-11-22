import { ActivityType, Client, Events, GatewayIntentBits } from "discord.js";
import { DEFAULT_AVATAR_DIR, loadAvatarStock } from "./avatar-stock.ts";
import { configWarnings, loadConfig } from "./config.ts";
import { isRelayable, toMessageLike } from "./discord-adapter.ts";
import { createMessageHandler } from "./handler.ts";
import { DEFAULT_HEARTBEAT_PATH, startHeartbeat } from "./heartbeat.ts";
import { createLogger } from "./logger.ts";
import { createSeatStatusClient } from "./seat-status-client.ts";
import { startWorkActivity } from "./work-activity.ts";
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
		// 発言の作者がいる VC（author_voice_channel_id）を member.voice から読むために要る
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

discord.once(Events.ClientReady, (c) => {
	logger.info("relay ready", { bot_user_id: c.user.id });
	startHeartbeat({
		path: process.env.HEARTBEAT_FILE ?? DEFAULT_HEARTBEAT_PATH,
		isReady: () => discord.isReady(),
	});
	if (cfg.seatStatus) {
		startWorkActivity({
			seatStatus: createSeatStatusClient({
				...cfg.seatStatus,
				partnerId: cfg.partnerId,
			}),
			setActivity: (text) => {
				if (text === null) c.user.setPresence({ activities: [] });
				else c.user.setActivity(text, { type: ActivityType.Custom });
			},
			setBio: async (text) => {
				try {
					await c.application.edit({ description: text });
					return true;
				} catch (e) {
					logger.warn("usage bio update failed", { error: String(e) });
					return false;
				}
			},
			logger,
		});
	}
});

discord.on(Events.MessageCreate, (message) => {
	const botUserId = discord.user?.id;
	if (!botUserId || message.author.id === botUserId) return;
	if (!isRelayable(message)) return;
	const channel = message.channel;
	const handle = createMessageHandler({
		client: yunomi,
		partnerId: cfg.partnerId,
		botUserId,
		avatars,
		workCategoryIds: cfg.workCategoryIds,
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

let shuttingDown = false;
const shutdown = async (signal: string) => {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info("shutting down", { signal });
	await discord.destroy();
	process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await discord.login(cfg.discordToken);
