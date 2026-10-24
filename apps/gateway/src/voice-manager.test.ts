import { EventEmitter } from "node:events";
import {
	AudioPlayerStatus,
	VoiceConnectionDisconnectReason,
	VoiceConnectionStatus,
} from "@discordjs/voice";
import { err, externalServiceUnavailable, ok } from "@yunomi/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Ears } from "./ears.ts";
import { silentLogger } from "./logger.ts";
import { type VoiceLib, VoiceManager } from "./voice-manager.ts";

class FakeConnection extends EventEmitter {
	state: { status: string } = { status: VoiceConnectionStatus.Signalling };
	rejoinAttempts = 0;
	rejoin = vi.fn();
	subscribe = vi.fn();
	receiver = { kind: "receiver" };
	constructor(
		public joinConfig: { guildId: string; channelId: string | null },
	) {
		super();
	}
	set(status: string, extra: Record<string, unknown> = {}) {
		const old = this.state;
		this.state = { status, ...extra };
		this.emit("stateChange", old, this.state);
	}
	destroy = vi.fn(() => this.set(VoiceConnectionStatus.Destroyed));
}

class FakePlayer extends EventEmitter {
	play = vi.fn();
	stop = vi.fn();
}

const values = {
	engine: "aivoice" as const,
	preset: "p",
	presetOverrides: {},
	masterOverrides: {
		Volume: 1,
		Speed: 1,
		Pitch: 1,
		PitchRange: 1,
		MiddlePause: 80,
		LongPause: 100,
		SentencePause: 200,
	},
};

const setup = (
	withOchoko = true,
	ears: Ears | null = null,
	listening = false,
) => {
	const connections = new Map<string, FakeConnection>();
	const players: FakePlayer[] = [];
	const lib = {
		joinVoiceChannel: vi.fn((o: { guildId: string; channelId: string }) => {
			const existing = connections.get(o.guildId);
			if (existing) {
				existing.joinConfig.channelId = o.channelId;
				return existing;
			}
			const c = new FakeConnection({
				guildId: o.guildId,
				channelId: o.channelId,
			});
			connections.set(o.guildId, c);
			return c;
		}),
		getVoiceConnection: vi.fn((g: string) => connections.get(g)),
		createAudioPlayer: vi.fn(() => {
			const p = new FakePlayer();
			players.push(p);
			return p;
		}),
		createResource: vi.fn((wav: Uint8Array) => ({ wav })),
		entersState: vi.fn(async () => undefined),
	};
	const yunomi = { reportVoiceConnection: vi.fn(async () => ok({})) };
	const ochoko = {
		synthesizeWithRetry: vi.fn(async (_r: { text: string }) =>
			ok({
				audio: new Uint8Array([1]),
				contentType: "audio/wav",
				durationMs: 1,
			}),
		),
		keepAwake: vi.fn(async () => ok(undefined)),
	};
	const warn = vi.fn();
	const manager = new VoiceManager({
		partnerId: "yukarin",
		ochoko: withOchoko ? ochoko : null,
		yunomi,
		ears,
		listening,
		adapterCreator: () => (() => ({})) as never,
		lib: lib as unknown as VoiceLib,
		sleep: async () => {},
		logger: { ...silentLogger, warn },
	});
	return { manager, lib, connections, players, yunomi, ochoko, warn };
};

const conn = (m: ReturnType<typeof setup>, g = "1") => {
	const c = m.connections.get(g);
	if (!c) throw new Error("not connected");
	return c;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("join / leave", () => {
	it("耳を閉じて接続し、Ready になってから接続先を報告する", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		expect(m.lib.joinVoiceChannel).toHaveBeenCalledWith(
			expect.objectContaining({
				guildId: "1",
				channelId: "vc1",
				selfDeaf: true,
				selfMute: false,
			}),
		);
		expect(m.yunomi.reportVoiceConnection).not.toHaveBeenCalled();
		conn(m).set(VoiceConnectionStatus.Ready);
		expect(m.yunomi.reportVoiceConnection).toHaveBeenCalledWith("yukarin", {
			guild_id: "1",
			channel_id: "vc1",
			listening: false,
		});
		expect(m.manager.channelOf("1")).toBe("vc1");
	});

	it("Ready のままの stateChange では、報告も keep_awake も重ねない", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		conn(m).set(VoiceConnectionStatus.Ready);
		conn(m).set(VoiceConnectionStatus.Ready);
		expect(m.yunomi.reportVoiceConnection).toHaveBeenCalledTimes(1);
		expect(m.ochoko.keepAwake).toHaveBeenCalledTimes(1);
	});

	it("切断から Ready に戻ったときは、もう一度報告する", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		conn(m).set(VoiceConnectionStatus.Ready);
		conn(m).set(VoiceConnectionStatus.Connecting);
		conn(m).set(VoiceConnectionStatus.Ready);
		expect(m.yunomi.reportVoiceConnection).toHaveBeenCalledTimes(2);
	});

	it("同じ VC への join は何もしない", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		await m.manager.join("1", "vc1");
		expect(m.lib.joinVoiceChannel).toHaveBeenCalledTimes(1);
	});

	it("別の VC へは接続を移し、新しい VC を報告する", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		await m.manager.join("1", "vc2");
		expect(m.players).toHaveLength(1);
		conn(m).set(VoiceConnectionStatus.Ready);
		expect(m.yunomi.reportVoiceConnection).toHaveBeenLastCalledWith("yukarin", {
			guild_id: "1",
			channel_id: "vc2",
			listening: false,
		});
	});

	it("別の guild の VC に入るときは、いまの接続を先に切る", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		const first = conn(m, "1");
		await m.manager.join("2", "vc9");
		expect(first.destroy).toHaveBeenCalled();
		expect(m.manager.channelOf("1")).toBeNull();
		expect(m.manager.channelOf("2")).toBe("vc9");
	});

	it("leave で切断し、null を報告する", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		m.manager.leave("1");
		expect(conn(m).destroy).toHaveBeenCalled();
		expect(m.yunomi.reportVoiceConnection).toHaveBeenLastCalledWith("yukarin", {
			guild_id: "1",
			channel_id: null,
			listening: false,
		});
		expect(m.manager.channelOf("1")).toBeNull();
	});

	it("追い出された・チャンネルが消えたときも null を報告する", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		conn(m).set(VoiceConnectionStatus.Destroyed);
		expect(m.yunomi.reportVoiceConnection).toHaveBeenLastCalledWith("yukarin", {
			guild_id: "1",
			channel_id: null,
			listening: false,
		});
	});

	it("Ready にならなければ切断する", async () => {
		const m = setup();
		m.lib.entersState.mockRejectedValueOnce(new Error("timeout"));
		await m.manager.join("1", "vc1");
		expect(conn(m).destroy).toHaveBeenCalled();
	});

	it("guild が見つからなければ入らない", async () => {
		const m = setup();
		const manager = new VoiceManager({
			partnerId: "yukarin",
			ochoko: null,
			yunomi: m.yunomi,
			adapterCreator: () => null,
			lib: m.lib as unknown as VoiceLib,
			logger: silentLogger,
		});
		await manager.join("1", "vc1");
		expect(m.lib.joinVoiceChannel).not.toHaveBeenCalled();
	});

	it("起動時に guild ごとに null を報告する", async () => {
		const m = setup();
		await m.manager.reportStartup(["1", "2"]);
		expect(m.yunomi.reportVoiceConnection).toHaveBeenCalledWith("yukarin", {
			guild_id: "1",
			channel_id: null,
			listening: false,
		});
		expect(m.yunomi.reportVoiceConnection).toHaveBeenCalledWith("yukarin", {
			guild_id: "2",
			channel_id: null,
			listening: false,
		});
	});

	it("切断中の復帰: 4014 は Connecting を待ち、来なければ destroy", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		m.lib.entersState.mockRejectedValueOnce(new Error("timeout"));
		conn(m).set(VoiceConnectionStatus.Disconnected, {
			reason: VoiceConnectionDisconnectReason.WebSocketClose,
			closeCode: 4014,
		});
		await vi.waitFor(() => expect(conn(m).destroy).toHaveBeenCalled());
	});

	it("切断中の復帰: それ以外は少し待って rejoin し、5 回を超えたら destroy", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		const c = conn(m);
		c.set(VoiceConnectionStatus.Disconnected, {
			reason: VoiceConnectionDisconnectReason.Manual,
		});
		await vi.waitFor(() => expect(c.rejoin).toHaveBeenCalled());
		c.rejoinAttempts = 5;
		c.set(VoiceConnectionStatus.Disconnected, {
			reason: VoiceConnectionDisconnectReason.Manual,
		});
		await vi.waitFor(() => expect(c.destroy).toHaveBeenCalled());
	});
});

describe("apply (voice directive)", () => {
	it("join → speak → leave の順に実行する", async () => {
		const m = setup();
		await m.manager.apply({
			join: { guild_id: "1", channel_id: "vc1" },
			speak: { channel_id: "vc1", text: "やあ", values },
			leave: { guild_id: "1" },
		});
		expect(m.lib.joinVoiceChannel).toHaveBeenCalled();
		expect(conn(m).destroy).toHaveBeenCalled();
	});

	it("speak_queue があれば speak は使わず、全件を順に積んで再生する", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		await m.manager.apply({
			speak: { channel_id: "vc1", text: "1", values },
			speak_queue: [
				{ channel_id: "vc1", text: "1", values },
				{ channel_id: "vc1", text: "2", values },
			],
		});
		await vi.waitFor(() => expect(m.players[0]?.play).toHaveBeenCalledTimes(2));
		expect(
			m.ochoko.synthesizeWithRetry.mock.calls.map((c) => c[0]?.text),
		).toEqual(["1", "2"]);
	});

	it("speak だけの古い Worker の指示も再生する", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		await m.manager.apply({ speak: { channel_id: "vc1", text: "1", values } });
		await vi.waitFor(() => expect(m.players[0]?.play).toHaveBeenCalledTimes(1));
	});

	it("undefined は何もしない", async () => {
		const m = setup();
		await m.manager.apply(undefined);
		expect(m.lib.joinVoiceChannel).not.toHaveBeenCalled();
	});
});

describe("speak", () => {
	it("接続中の VC なら合成して再生する", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		m.manager.speak({ channel_id: "vc1", text: "やあ", values });
		await vi.waitFor(() => expect(m.players[0]?.play).toHaveBeenCalled());
		expect(m.ochoko.synthesizeWithRetry).toHaveBeenCalledWith({
			text: "やあ",
			values,
		});
		expect(m.lib.createResource).toHaveBeenCalledWith(new Uint8Array([1]));
		expect(m.lib.entersState).toHaveBeenCalledWith(
			m.players[0],
			AudioPlayerStatus.Idle,
			expect.any(Number),
		);
	});

	it("入っていない VC 宛ては捨てる", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		m.manager.speak({ channel_id: "other", text: "やあ", values });
		expect(m.ochoko.synthesizeWithRetry).not.toHaveBeenCalled();
		expect(m.warn).toHaveBeenCalled();
	});

	it("続けて来た発話は順番に再生する", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		m.manager.speak({ channel_id: "vc1", text: "1", values });
		m.manager.speak({ channel_id: "vc1", text: "2", values });
		await vi.waitFor(() => expect(m.players[0]?.play).toHaveBeenCalledTimes(2));
		expect(
			m.ochoko.synthesizeWithRetry.mock.calls.map((c) => c[0]?.text),
		).toEqual(["1", "2"]);
	});

	it("合成に失敗した発話は捨てて次へ進む", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		m.ochoko.synthesizeWithRetry.mockResolvedValueOnce(
			err(externalServiceUnavailable({ service: "ochoko" })) as never,
		);
		m.manager.speak({ channel_id: "vc1", text: "1", values });
		m.manager.speak({ channel_id: "vc1", text: "2", values });
		await vi.waitFor(() => expect(m.players[0]?.play).toHaveBeenCalledTimes(1));
		expect(m.warn).toHaveBeenCalled();
	});

	it("ochoko 未設定なら一度だけ警告して捨てる", async () => {
		const m = setup(false);
		await m.manager.join("1", "vc1");
		m.manager.speak({ channel_id: "vc1", text: "1", values });
		m.manager.speak({ channel_id: "vc1", text: "2", values });
		expect(m.warn).toHaveBeenCalledTimes(1);
		expect(m.players[0]?.play).not.toHaveBeenCalled();
	});
});

describe("keep_awake", () => {
	it("Ready ですぐ送り、5 分ごとに続け、切断で止める", async () => {
		const m = setup();
		await m.manager.join("1", "vc1");
		expect(m.ochoko.keepAwake).not.toHaveBeenCalled();
		conn(m).set(VoiceConnectionStatus.Ready);
		expect(m.ochoko.keepAwake).toHaveBeenCalledTimes(1);
		expect(m.ochoko.keepAwake).toHaveBeenCalledWith({
			ttlSeconds: 900,
			partnerId: "yukarin",
		});
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(m.ochoko.keepAwake).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(m.ochoko.keepAwake).toHaveBeenCalledTimes(3);
		m.manager.leave("1");
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(m.ochoko.keepAwake).toHaveBeenCalledTimes(3);
	});

	it("失敗しても警告して次の周期で続ける", async () => {
		const m = setup();
		m.ochoko.keepAwake.mockResolvedValueOnce(
			err(externalServiceUnavailable({ service: "ochoko" })) as never,
		);
		await m.manager.join("1", "vc1");
		conn(m).set(VoiceConnectionStatus.Ready);
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(m.warn).toHaveBeenCalled();
		expect(m.ochoko.keepAwake).toHaveBeenCalledTimes(2);
	});

	it("ochoko 未設定なら送らない", async () => {
		const m = setup(false);
		await m.manager.join("1", "vc1");
		conn(m).set(VoiceConnectionStatus.Ready);
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(m.ochoko.keepAwake).not.toHaveBeenCalled();
	});
});

describe("ears", () => {
	const fakeEars = () => {
		const stop = vi.fn();
		const listen = vi.fn<Ears["listen"]>(() => stop);
		return { ears: { listen }, listen, stop };
	};

	it("耳があれば耳を開けて入り、Ready で聞き始める", async () => {
		const e = fakeEars();
		const m = setup(true, e.ears);
		await m.manager.join("1", "vc1");
		expect(m.lib.joinVoiceChannel).toHaveBeenCalledWith(
			expect.objectContaining({ selfDeaf: false }),
		);
		expect(e.listen).not.toHaveBeenCalled();
		conn(m).set(VoiceConnectionStatus.Ready);
		expect(e.listen).toHaveBeenCalledTimes(1);
		expect(e.listen.mock.calls[0]?.[0]).toBe(conn(m).receiver);
	});

	it("再接続で Ready に戻っても聞き直さない", async () => {
		const e = fakeEars();
		const m = setup(true, e.ears);
		await m.manager.join("1", "vc1");
		conn(m).set(VoiceConnectionStatus.Ready);
		conn(m).set(VoiceConnectionStatus.Disconnected, {
			reason: VoiceConnectionDisconnectReason.WebSocketClose,
			closeCode: 4000,
		});
		conn(m).set(VoiceConnectionStatus.Ready);
		expect(e.listen).toHaveBeenCalledTimes(1);
	});

	it("発話の時点の VC を返し、切断で聞くのをやめる", async () => {
		const e = fakeEars();
		const m = setup(true, e.ears);
		await m.manager.join("1", "vc1");
		conn(m).set(VoiceConnectionStatus.Ready);
		const where = e.listen.mock.calls[0]?.[1];
		expect(where?.()).toEqual({ guildId: "1", channelId: "vc1" });
		await m.manager.join("1", "vc2");
		expect(where?.()).toEqual({ guildId: "1", channelId: "vc2" });
		m.manager.leave("1");
		expect(e.stop).toHaveBeenCalledTimes(1);
		expect(where?.()).toBeNull();
	});
});

describe("listening", () => {
	it("聞いた発話を届けられるときは、接続の報告に listening を付ける", async () => {
		const m = setup(true, { listen: () => () => {} }, true);
		await m.manager.join("1", "vc1");
		conn(m).set(VoiceConnectionStatus.Ready);
		expect(m.yunomi.reportVoiceConnection).toHaveBeenLastCalledWith("yukarin", {
			guild_id: "1",
			channel_id: "vc1",
			listening: true,
		});
		m.manager.leave("1");
		expect(m.yunomi.reportVoiceConnection).toHaveBeenLastCalledWith("yukarin", {
			guild_id: "1",
			channel_id: null,
			listening: false,
		});
	});
});
