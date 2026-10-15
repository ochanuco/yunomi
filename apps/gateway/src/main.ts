import {
	ChannelType,
	Client,
	Events,
	GatewayIntentBits,
	type Message,
} from "discord.js";
import { loadConfig } from "./config.ts";
import { createMessageHandler } from "./handler.ts";
import { DEFAULT_HEARTBEAT_PATH, startHeartbeat } from "./heartbeat.ts";
import { createLogger } from "./logger.ts";
import type { MessageLike } from "./to-envelope.ts";
import { YunomiClient } from "./yunomi-client.ts";

const PARTNER_ID = "yukarin";

const mentionsBotRole = (m: Message): boolean => {
	const botRoleId = m.guild?.members.me?.roles.botRole?.id;
	return botRoleId !== undefined && m.mentions.roles.has(botRoleId);
};

const toMessageLike = (m: Message): MessageLike => ({
	id: m.id,
	guildId: m.guildId,
	channelId: m.channelId,
	content: m.content,
	createdAt: m.createdAt,
	author: {
		id: m.author.id,
		bot: m.author.bot,
		displayName: m.member?.displayName ?? m.author.displayName,
	},
	mentionedUserIds: [...m.mentions.users.keys()],
	mentionsBotRole: mentionsBotRole(m),
	replyToMessageId: m.reference?.messageId ?? null,
	attachments: [...m.attachments.values()].map((a) => ({
		name: a.name,
		contentType: a.contentType,
		size: a.size,
	})),
});

const config = loadConfig(process.env);
if (!config.ok) {
	console.error("設定が不正です:");
	for (const issue of config.error) console.error(`  - ${issue}`);
	process.exit(1);
}
const cfg = config.value;
const logger = createLogger(cfg.logLevel);

const discord = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
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
	logger.info("gateway ready", { bot_user_id: c.user.id });
	startHeartbeat({
		path: process.env.HEARTBEAT_FILE ?? DEFAULT_HEARTBEAT_PATH,
		isReady: () => discord.isReady(),
	});
});

discord.on(Events.MessageCreate, (message) => {
	const botUserId = discord.user?.id;
	if (!botUserId || message.author.id === botUserId) return;
	// DM や Thread 以外の非テキストは対象外
	if (!message.inGuild() || message.channel.type === ChannelType.GuildVoice) {
		return;
	}
	const channel = message.channel;
	if (!channel.isTextBased()) return;
	const handle = createMessageHandler({
		client: yunomi,
		partnerId: PARTNER_ID,
		botUserId,
		logger,
	});
	void handle(toMessageLike(message), {
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
