import {
	type CapabilityPolicy,
	createCapabilityGate,
	createGoogleCalendarAdapter,
	createToolRegistry,
	type PendingStore,
} from "@yunomi/capabilities";
import type { TurnCapabilities } from "./do/tool-loop.ts";

/** 道具が使う binding。prod だけが持つので、どれも欠けうる。 */
export type CapabilityEnv = {
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	GOOGLE_REFRESH_TOKEN?: string;
	GOOGLE_CALENDAR_ID?: string;
	OWNER_DISCORD_USER_ID?: string;
};

export type CapabilityDeps = {
	pending: PendingStore;
	policy: CapabilityPolicy;
	now: () => Date;
	/** テストが Google への通信を差し替える。既定は Worker の fetch。 */
	fetch?: typeof fetch;
};

/** Google の認証情報とオーナーの Discord user id が揃っているときだけ作る。 */
export const defaultCapabilities = (
	env: CapabilityEnv,
	deps: CapabilityDeps,
): TurnCapabilities | null => {
	const {
		GOOGLE_CLIENT_ID: clientId,
		GOOGLE_CLIENT_SECRET: clientSecret,
		GOOGLE_REFRESH_TOKEN: refreshToken,
		GOOGLE_CALENDAR_ID: calendarId,
		OWNER_DISCORD_USER_ID: ownerId,
	} = env;
	if (!clientId || !clientSecret || !refreshToken || !calendarId || !ownerId) {
		return null;
	}
	// fetch を this なしで呼ぶと Workers では Illegal invocation になるため、包んで渡す。
	const doFetch: typeof fetch =
		deps.fetch ?? ((input, init) => fetch(input, init));
	const registry = createToolRegistry([
		createGoogleCalendarAdapter({
			fetch: doFetch,
			credentials: { clientId, clientSecret, refreshToken },
			calendarId,
			now: deps.now,
		}),
	]);
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
		isOwner: (speakerId) => speakerId === ownerId,
	};
};
