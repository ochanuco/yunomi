import {
	VOICE_DIRECTIVE,
	voiceSocketMessageSchema,
	voiceSocketPathFor,
} from "@yunomi/protocol";
import * as v from "valibot";
import type { Logger } from "./logger.ts";
import type { VoiceManager } from "./voice-manager.ts";

// PartnerDO の setWebSocketAutoResponse が DO を起こさずに返す組
export const PING = "ping";
const PONG = "pong";

export const PING_INTERVAL_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
// これだけ開いていれば、次に切れたときは最初の待ち時間から数え直す
const STABLE_MS = 60_000;

/** WebSocket のうち使う部分。テストでは fake を渡す。 */
export type SocketLike = {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open" | "close" | "error", fn: () => void): void;
	addEventListener(
		type: "message",
		fn: (event: { data: unknown }) => void,
	): void;
};

export type SocketFactory = (
	url: string,
	headers: Record<string, string>,
) => SocketLike;

// Node の WebSocket（undici）は第 2 引数で任意のヘッダーを受け付ける
const defaultFactory: SocketFactory = (url, headers) =>
	new WebSocket(url, { headers });

export type VoiceSocketDeps = {
	baseUrl: string;
	partnerId: string;
	headers: Record<string, string>;
	voice: Pick<VoiceManager, "apply" | "channelOf">;
	logger: Logger;
	connect?: SocketFactory;
	/** 0 以上 1 未満。待ち時間の揺らぎに使う。 */
	random?: () => number;
};

export type VoiceSocket = { stop(): void };

/** n 回目（0 始まり）のつなぎ直しまでの待ち時間。上限つきの指数で、後半を揺らす。 */
export const backoffMs = (attempt: number, random: () => number): number => {
	const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
	return Math.round(ceiling / 2 + (random() * ceiling) / 2);
};

const toWsUrl = (httpUrl: string): string =>
	httpUrl.replace(/^http(s?):\/\//, (_, s: string) => `ws${s}://`);

/**
 * PartnerDO の声の指示の WebSocket につなぎ、届いた指示を VoiceManager に渡す。
 * 切れたらつなぎ直し、stop() まで続ける。
 */
export const startVoiceSocket = (deps: VoiceSocketDeps): VoiceSocket => {
	const log = deps.logger;
	const connect = deps.connect ?? defaultFactory;
	const random = deps.random ?? Math.random;
	const url = `${toWsUrl(deps.baseUrl.replace(/\/+$/, ""))}${voiceSocketPathFor(deps.partnerId)}`;

	let stopped = false;
	let attempt = 0;
	let socket: SocketLike | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let stableTimer: ReturnType<typeof setTimeout> | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;

	const clearTimers = () => {
		if (pingTimer) clearInterval(pingTimer);
		if (stableTimer) clearTimeout(stableTimer);
		pingTimer = null;
		stableTimer = null;
	};

	const onMessage = (data: unknown) => {
		if (data === PONG) return;
		let json: unknown;
		try {
			json = typeof data === "string" ? JSON.parse(data) : undefined;
		} catch {
			json = undefined;
		}
		const parsed = v.safeParse(voiceSocketMessageSchema, json);
		if (!parsed.success) {
			log.warn("voice socket message dropped", {
				issues: parsed.issues.map((i) => v.getDotPath(i) ?? i.message),
			});
			return;
		}
		const msg = parsed.output;
		if (msg.type !== VOICE_DIRECTIVE) return;
		const at = { guild_id: msg.guild_id, channel_id: msg.channel_id };
		if (msg.partner_id !== deps.partnerId) {
			log.warn("voice directive for other partner dropped", {
				...at,
				partner_id: msg.partner_id,
			});
			return;
		}
		log.info("voice directive received", {
			...at,
			connected_channel_id: deps.voice.channelOf(msg.guild_id),
		});
		// 接続先と合わない speak は VoiceManager が捨てる。HTTP の応答の指示と同じ扱いにする
		void deps.voice.apply(msg.voice).catch((e: unknown) => {
			log.error("voice directive failed", {
				...at,
				error: e instanceof Error ? e.name : "unknown",
			});
		});
	};

	const scheduleReconnect = () => {
		if (stopped || retryTimer) return;
		const wait = backoffMs(attempt, random);
		attempt++;
		log.info("voice socket reconnecting", { attempt, wait_ms: wait });
		retryTimer = setTimeout(() => {
			retryTimer = null;
			open();
		}, wait);
	};

	const open = () => {
		if (stopped) return;
		let s: SocketLike;
		try {
			s = connect(url, deps.headers);
		} catch (e) {
			log.warn("voice socket connect failed", {
				error: e instanceof Error ? e.name : "unknown",
			});
			scheduleReconnect();
			return;
		}
		socket = s;
		// 古い接続のイベントで今の接続の状態を崩さない
		const current = () => socket === s;
		s.addEventListener("open", () => {
			if (!current()) return;
			log.info("voice socket open", { partner_id: deps.partnerId });
			pingTimer = setInterval(() => {
				try {
					s.send(PING);
				} catch {
					// 送れないなら close が続いて届く
				}
			}, PING_INTERVAL_MS);
			stableTimer = setTimeout(() => {
				attempt = 0;
			}, STABLE_MS);
		});
		s.addEventListener("message", (event) => {
			if (current()) onMessage(event.data);
		});
		const onDown = (kind: "close" | "error") => () => {
			if (!current()) return;
			socket = null;
			clearTimers();
			if (stopped) return;
			log.warn("voice socket down", { kind });
			if (kind === "error") {
				try {
					s.close();
				} catch {
					// すでに閉じている
				}
			}
			scheduleReconnect();
		};
		s.addEventListener("close", onDown("close"));
		s.addEventListener("error", onDown("error"));
	};

	open();

	return {
		stop() {
			if (stopped) return;
			stopped = true;
			clearTimers();
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = null;
			const s = socket;
			socket = null;
			try {
				s?.close(1000, "shutdown");
			} catch {
				// すでに閉じている
			}
		},
	};
};
