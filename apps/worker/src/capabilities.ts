import {
	type CapabilityAdapter,
	type CapabilityPolicy,
	createCapabilityGate,
	createChatsumiAdapter,
	createDiscordAttachmentAdapter,
	createGithubAdapter,
	createGoogleCalendarAdapter,
	createGooglePlacesAdapter,
	createHomeAssistantAdapter,
	createToolRegistry,
	type PendingStore,
	parseHomeEntityIds,
} from "@yunomi/capabilities";
import type { TurnCapabilities } from "./do/tool-loop.ts";

/** 道具が使う binding。prod だけが持つので、どれも欠けうる。 */
export type CapabilityEnv = {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GOOGLE_REFRESH_TOKEN?: string;
	GOOGLE_CALENDAR_ID?: string;
	GOOGLE_PLACES_API_KEY?: string;
	GITHUB_TOKEN?: string;
	/** github_read が repo を省略されたときに読む `owner/name`。 */
	GITHUB_DEFAULT_REPO?: string;
	/** web_fetch の呼び先 chatsumi の origin。 */
	CHATSUMI_URL?: string;
	/** chatsumi の Cloudflare Access のサービストークン。ochoko と wol のものとは別。 */
	CHATSUMI_ACCESS_CLIENT_ID?: string;
	CHATSUMI_ACCESS_CLIENT_SECRET?: string;
	/** home_state の呼び先 Home Assistant の origin。 */
	HOME_ASSISTANT_URL?: string;
	/** Yukarin 用の Home Assistant ユーザーの long-lived access token。 */
	HOME_ASSISTANT_TOKEN?: string;
	/** home_state が読む entity ID（カンマ区切り）。これ以外は読ませない。 */
	HOME_ENTITY_IDS?: string;
	OWNER_DISCORD_USER_ID?: string;
	/** 添付の読み取りに使う。送信と同じ bot の token。 */
	DISCORD_BOT_TOKEN?: string;
};

export type CapabilityDeps = {
	pending: PendingStore;
	policy: CapabilityPolicy;
	now: () => Date;
	/** テストが Google への通信を差し替える。既定は Worker の fetch。 */
	fetch?: typeof fetch;
};

/**
 * 道具ごとに、その認証情報が揃っているときだけ登録する。どれも登録されなければ null。
 * カレンダーはオーナーの Discord user id も要る。
 */
export const defaultCapabilities = (
	env: CapabilityEnv,
	deps: CapabilityDeps,
): TurnCapabilities | null => {
	const {
		GOOGLE_CLIENT_ID: clientId,
		GOOGLE_CLIENT_SECRET: clientSecret,
		GOOGLE_REFRESH_TOKEN: refreshToken,
		GOOGLE_CALENDAR_ID: calendarId,
		GOOGLE_PLACES_API_KEY: placesApiKey,
		GITHUB_TOKEN: githubToken,
		GITHUB_DEFAULT_REPO: githubDefaultRepo,
		CHATSUMI_URL: chatsumiUrl,
		CHATSUMI_ACCESS_CLIENT_ID: chatsumiClientId,
		CHATSUMI_ACCESS_CLIENT_SECRET: chatsumiClientSecret,
		HOME_ASSISTANT_URL: homeAssistantUrl,
		HOME_ASSISTANT_TOKEN: homeAssistantToken,
		HOME_ENTITY_IDS: homeEntityIdsRaw,
		OWNER_DISCORD_USER_ID: ownerId,
		DISCORD_BOT_TOKEN: botToken,
	} = env;
	// fetch を this なしで呼ぶと Workers では Illegal invocation になるため、包んで渡す。
	const doFetch: typeof fetch =
		deps.fetch ?? ((input, init) => fetch(input, init));
	const adapters: CapabilityAdapter[] = [];
	if (clientId && clientSecret && refreshToken && calendarId && ownerId) {
		adapters.push(
			createGoogleCalendarAdapter({
				fetch: doFetch,
				credentials: { clientId, clientSecret, refreshToken },
				calendarId,
				now: deps.now,
			}),
		);
	}
	if (placesApiKey) {
		adapters.push(
			createGooglePlacesAdapter({ fetch: doFetch, apiKey: placesApiKey }),
		);
	}
	if (githubToken) {
		adapters.push(
			createGithubAdapter({
				fetch: doFetch,
				token: githubToken,
				...(githubDefaultRepo ? { defaultRepo: githubDefaultRepo } : {}),
			}),
		);
	}
	if (chatsumiUrl && chatsumiClientId && chatsumiClientSecret) {
		adapters.push(
			createChatsumiAdapter({
				fetch: doFetch,
				baseUrl: chatsumiUrl,
				accessClientId: chatsumiClientId,
				accessClientSecret: chatsumiClientSecret,
			}),
		);
	}
	const homeEntityIds = parseHomeEntityIds(homeEntityIdsRaw ?? "");
	if (homeAssistantUrl && homeAssistantToken && homeEntityIds.length > 0) {
		adapters.push(
			createHomeAssistantAdapter({
				fetch: doFetch,
				baseUrl: homeAssistantUrl,
				token: homeAssistantToken,
				entityIds: homeEntityIds,
			}),
		);
	}
	// owner がいない環境（dev）では gate がすべて拒否するので、道具の一覧にも出さない。
	if (botToken && ownerId) {
		adapters.push(createDiscordAttachmentAdapter({ fetch: doFetch, botToken }));
	}
	if (adapters.length === 0) return null;
	const registry = createToolRegistry(adapters);
	if (!registry.ok) {
		console.error("capability registry invalid", registry.error);
		return null;
	}
	return {
		gate: createCapabilityGate({
			registry: registry.value,
			policy: deps.policy,
			pending: deps.pending,
			now: deps.now,
		}),
		pending: deps.pending,
		isOwner: (speakerId) => !!ownerId && speakerId === ownerId,
	};
};
