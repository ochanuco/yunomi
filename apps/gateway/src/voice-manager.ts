import { Readable } from "node:stream";
import {
	type AudioPlayer,
	AudioPlayerStatus,
	type AudioResource,
	createAudioPlayer,
	createAudioResource,
	type DiscordGatewayAdapterCreator,
	entersState,
	getVoiceConnection,
	joinVoiceChannel,
	StreamType,
	type VoiceConnection,
	VoiceConnectionDisconnectReason,
	VoiceConnectionStatus,
} from "@discordjs/voice";
import type { SpeechRequest } from "@yunomi/core";
import {
	type SpeakDirective,
	speakQueueOf,
	type VoiceDirective,
} from "@yunomi/protocol";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";
import type { OchokoClient } from "./ochoko-client.ts";
import type { YunomiClient } from "./yunomi-client.ts";

const KEEP_AWAKE_TTL_SECONDS = 900;
const KEEP_AWAKE_INTERVAL_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 30_000;
const PLAYBACK_READY_TIMEOUT_MS = 20_000;
// 1 発話の再生が止まったままにならないための上限
const PLAYBACK_TIMEOUT_MS = 5 * 60_000;

/** @discordjs/voice のうち VoiceManager が使う関数。テストで差し替える。 */
export type VoiceLib = {
	joinVoiceChannel: typeof joinVoiceChannel;
	getVoiceConnection: typeof getVoiceConnection;
	createAudioPlayer: typeof createAudioPlayer;
	/** WAV を ffmpeg で 48kHz ステレオの Opus 入力へ変換して再生資源にする。ファイルは作らない。 */
	createResource: (wav: Uint8Array) => AudioResource;
	entersState: typeof entersState;
};

export const defaultVoiceLib: VoiceLib = {
	joinVoiceChannel,
	getVoiceConnection,
	createAudioPlayer,
	createResource: (wav) =>
		createAudioResource(Readable.from([Buffer.from(wav)]), {
			inputType: StreamType.Arbitrary,
		}),
	entersState,
};

export type VoiceManagerDeps = {
	partnerId: string;
	/** null なら speak と keep_awake は無効。 */
	ochoko: Pick<OchokoClient, "synthesizeWithRetry" | "keepAwake"> | null;
	yunomi: Pick<YunomiClient, "reportVoiceConnection">;
	/** guild が見つからなければ null。 */
	adapterCreator: (guildId: string) => DiscordGatewayAdapterCreator | null;
	lib?: VoiceLib;
	sleep?: (ms: number) => Promise<void>;
	logger?: Logger;
};

type Session = {
	guildId: string;
	connection: VoiceConnection;
	player: AudioPlayer;
	queue: SpeechRequest[];
	draining: boolean;
	keepAwakeTimer: ReturnType<typeof setInterval> | null;
	closed: boolean;
};

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export class VoiceManager {
	readonly #deps: VoiceManagerDeps;
	readonly #lib: VoiceLib;
	readonly #sleep: (ms: number) => Promise<void>;
	readonly #log: Logger;
	readonly #sessions = new Map<string, Session>();
	readonly #pending = new Set<Promise<unknown>>();
	#warnedNoOchoko = false;

	constructor(deps: VoiceManagerDeps) {
		this.#deps = deps;
		this.#lib = deps.lib ?? defaultVoiceLib;
		this.#sleep = deps.sleep ?? defaultSleep;
		this.#log = deps.logger ?? silentLogger;
	}

	/** いま接続している VC。接続していなければ null。 */
	channelOf(guildId: string): string | null {
		const s = this.#sessions.get(guildId);
		if (!s || s.closed) return null;
		return s.connection.joinConfig.channelId;
	}

	/** Worker の指示を、join → speak → leave の順で実行する。speak は待たない。 */
	async apply(directive: VoiceDirective | undefined): Promise<void> {
		if (!directive) return;
		if (directive.join) {
			await this.join(directive.join.guild_id, directive.join.channel_id);
		}
		for (const speak of speakQueueOf(directive)) this.speak(speak);
		if (directive.leave) this.leave(directive.leave.guild_id);
	}

	async join(guildId: string, channelId: string): Promise<void> {
		const existing = this.#sessions.get(guildId);
		if (existing && this.channelOf(guildId) === channelId) return;
		// VC は同時に 1 つだけ
		for (const other of this.#sessions.keys()) {
			if (other !== guildId) this.leave(other);
		}
		const adapterCreator = this.#deps.adapterCreator(guildId);
		if (!adapterCreator) {
			this.#log.warn("voice join skipped: guild not found", {
				guild_id: guildId,
			});
			return;
		}
		const connection = this.#lib.joinVoiceChannel({
			channelId,
			guildId,
			adapterCreator,
			// まだ聞き取れないので耳を閉じる
			selfDeaf: true,
			selfMute: false,
		});
		this.#log.info("voice join", { guild_id: guildId, channel_id: channelId });
		if (!existing || existing.connection !== connection) {
			this.#open(guildId, connection);
		}
		try {
			await this.#lib.entersState(
				connection,
				VoiceConnectionStatus.Ready,
				READY_TIMEOUT_MS,
			);
		} catch {
			this.#log.warn("voice connection not ready", {
				guild_id: guildId,
				channel_id: channelId,
			});
			if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
				connection.destroy();
			}
		}
	}

	leave(guildId: string): void {
		const connection =
			this.#sessions.get(guildId)?.connection ??
			this.#lib.getVoiceConnection(guildId);
		if (!connection) return;
		this.#log.info("voice leave", { guild_id: guildId });
		if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
			connection.destroy();
		}
	}

	speak(speak: SpeakDirective): void {
		if (!this.#deps.ochoko) {
			if (!this.#warnedNoOchoko) {
				this.#warnedNoOchoko = true;
				this.#log.warn("speak dropped: OCHOKO_URL/AIVOICE_TOKEN not set");
			}
			return;
		}
		const session = [...this.#sessions.values()].find(
			(s) =>
				!s.closed && s.connection.joinConfig.channelId === speak.channel_id,
		);
		if (!session) {
			this.#log.warn("speak dropped: not connected to channel", {
				channel_id: speak.channel_id,
			});
			return;
		}
		session.queue.push({ text: speak.text, values: speak.values });
		void this.#drain(session);
	}

	/** 起動時に、Worker が覚えている古い接続先を消させる。 */
	async reportStartup(guildIds: readonly string[]): Promise<void> {
		await Promise.all(guildIds.map((g) => this.#report(g, null)));
	}

	/** 終了前に接続を閉じ、切断の報告が済むのを待つ。 */
	async shutdown(): Promise<void> {
		for (const guildId of [...this.#sessions.keys()]) this.leave(guildId);
		await Promise.allSettled([...this.#pending]);
	}

	#open(guildId: string, connection: VoiceConnection): void {
		const player = this.#lib.createAudioPlayer();
		const session: Session = {
			guildId,
			connection,
			player,
			queue: [],
			draining: false,
			keepAwakeTimer: null,
			closed: false,
		};
		this.#sessions.set(guildId, session);
		connection.subscribe(player);
		player.on("error", (e) => {
			this.#log.warn("audio player error", {
				guild_id: guildId,
				error: e.name,
			});
		});
		connection.on("stateChange", (old, state) => {
			if (state.status === VoiceConnectionStatus.Ready) {
				// Ready のまま networking だけが替わっても stateChange は来る。入ったときだけ扱う
				if (old.status !== VoiceConnectionStatus.Ready) this.#onReady(session);
			} else if (state.status === VoiceConnectionStatus.Disconnected) {
				void this.#onDisconnected(session, state);
			} else if (state.status === VoiceConnectionStatus.Destroyed) {
				this.#onDestroyed(session);
			}
		});
	}

	#onReady(session: Session): void {
		const channelId = session.connection.joinConfig.channelId;
		this.#log.info("voice ready", {
			guild_id: session.guildId,
			channel_id: channelId,
		});
		void this.#report(session.guildId, channelId);
		this.#startKeepAwake(session);
	}

	async #onDisconnected(
		session: Session,
		state: { reason: VoiceConnectionDisconnectReason; closeCode?: number },
	): Promise<void> {
		const { connection } = session;
		const destroy = () => {
			if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
				connection.destroy();
			}
		};
		if (
			state.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
			state.closeCode === 4014
		) {
			// 別の VC へ移された間は再接続が始まる。始まらなければ追い出されたとみなす
			try {
				await this.#lib.entersState(
					connection,
					VoiceConnectionStatus.Connecting,
					5_000,
				);
			} catch {
				destroy();
			}
		} else if (connection.rejoinAttempts < 5) {
			await this.#sleep((connection.rejoinAttempts + 1) * 5_000);
			if (connection.state.status === VoiceConnectionStatus.Disconnected) {
				connection.rejoin();
			}
		} else {
			destroy();
		}
	}

	#onDestroyed(session: Session): void {
		if (session.closed) return;
		session.closed = true;
		session.queue.length = 0;
		if (session.keepAwakeTimer) clearInterval(session.keepAwakeTimer);
		session.keepAwakeTimer = null;
		session.player.stop(true);
		if (this.#sessions.get(session.guildId) === session) {
			this.#sessions.delete(session.guildId);
		}
		this.#log.info("voice disconnected", { guild_id: session.guildId });
		void this.#report(session.guildId, null);
	}

	#report(guildId: string, channelId: string | null): Promise<void> {
		const task = this.#deps.yunomi
			.reportVoiceConnection(this.#deps.partnerId, {
				guild_id: guildId,
				channel_id: channelId,
			})
			.then((r) => {
				if (!r.ok) {
					this.#log.warn("voice connection report failed", {
						guild_id: guildId,
						error: r.error.type,
					});
				}
			})
			.catch((e: unknown) => {
				this.#log.warn("voice connection report failed", {
					guild_id: guildId,
					error: e instanceof Error ? e.name : "unknown",
				});
			})
			.finally(() => this.#pending.delete(task));
		this.#pending.add(task);
		return task;
	}

	#startKeepAwake(session: Session): void {
		const { ochoko } = this.#deps;
		if (!ochoko) return;
		const tick = () => {
			void ochoko
				.keepAwake({
					ttlSeconds: KEEP_AWAKE_TTL_SECONDS,
					partnerId: this.#deps.partnerId,
				})
				.then((r) => {
					if (!r.ok) {
						this.#log.warn("keep_awake failed", { error: r.error.type });
					}
				})
				.catch((e: unknown) => {
					this.#log.warn("keep_awake failed", {
						error: e instanceof Error ? e.name : "unknown",
					});
				});
		};
		tick();
		session.keepAwakeTimer ??= setInterval(tick, KEEP_AWAKE_INTERVAL_MS);
	}

	async #drain(session: Session): Promise<void> {
		const { ochoko } = this.#deps;
		if (!ochoko || session.draining) return;
		session.draining = true;
		try {
			for (
				let item = session.queue.shift();
				item && !session.closed;
				item = session.queue.shift()
			) {
				const synthesized = await ochoko.synthesizeWithRetry(item);
				if (session.closed) break;
				if (!synthesized.ok) {
					this.#log.warn("speak dropped: synthesize failed", {
						guild_id: session.guildId,
						error: synthesized.error.type,
						length: item.text.length,
					});
					continue;
				}
				try {
					await this.#lib.entersState(
						session.connection,
						VoiceConnectionStatus.Ready,
						PLAYBACK_READY_TIMEOUT_MS,
					);
				} catch {
					this.#log.warn("speak dropped: connection not ready", {
						guild_id: session.guildId,
					});
					continue;
				}
				session.player.play(this.#lib.createResource(synthesized.value.audio));
				await this.#lib
					.entersState(
						session.player,
						AudioPlayerStatus.Idle,
						PLAYBACK_TIMEOUT_MS,
					)
					.catch(() => {
						this.#log.warn("playback did not finish", {
							guild_id: session.guildId,
						});
						session.player.stop(true);
					});
			}
		} finally {
			session.draining = false;
		}
	}
}
