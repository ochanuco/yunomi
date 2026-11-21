import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger.ts";
import {
	backoffMs,
	PING,
	PING_INTERVAL_MS,
	type SocketLike,
	startVoiceSocket,
} from "./voice-socket.ts";

const BACKOFF_ENOUGH = 120_000;

type Listener = (event: { data: unknown }) => void;

class FakeSocket implements SocketLike {
	readonly listeners = new Map<string, Listener[]>();
	readonly sent: string[] = [];
	closed = false;
	constructor(
		readonly url: string,
		readonly headers: Record<string, string>,
	) {}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.closed = true;
	}
	addEventListener(type: string, fn: Listener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	emit(type: string, event: { data: unknown } = { data: undefined }) {
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
}

const directive = {
	type: "voice.directive",
	partner_id: "yukarin",
	guild_id: "1",
	channel_id: "7",
	voice: {
		speak: {
			channel_id: "7",
			text: "おはよう",
			values: {
				engine: "aivoice",
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
			},
		},
	},
};

const setup = () => {
	const sockets: FakeSocket[] = [];
	const apply = vi.fn(async () => {});
	const warn = vi.fn();
	const handle = startVoiceSocket({
		baseUrl: "https://yunomi.example/",
		partnerId: "yukarin",
		headers: { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "s" },
		voice: { apply, channelOf: () => "7" },
		logger: { ...silentLogger, warn },
		// 揺らぎの幅の上端に固定して、待ち時間を読みやすくする
		random: () => 0.999999,
		connect: (url, headers) => {
			const s = new FakeSocket(url, headers);
			sockets.push(s);
			return s;
		},
	});
	const last = () => {
		const s = sockets.at(-1);
		if (!s) throw new Error("no socket");
		return s;
	};
	return { sockets, last, apply, warn, handle };
};

describe("startVoiceSocket", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("パートナーの socket の口に Access のヘッダーつきでつなぐ", () => {
		const { last, handle } = setup();
		expect(last().url).toBe(
			"wss://yunomi.example/v1/partners/yukarin/voice/socket",
		);
		expect(last().headers["CF-Access-Client-Id"]).toBe("id");
		handle.stop();
	});

	it("届いた声の指示を VoiceManager に渡す", () => {
		const { last, apply, handle } = setup();
		last().emit("open");
		last().emit("message", { data: JSON.stringify(directive) });
		expect(apply).toHaveBeenCalledWith(directive.voice);
		handle.stop();
	});

	it("不正なメッセージと pong は捨て、不正なものだけ warn に残す", () => {
		const { last, apply, warn, handle } = setup();
		last().emit("open");
		last().emit("message", { data: "pong" });
		last().emit("message", { data: "{not json" });
		last().emit("message", {
			data: JSON.stringify({ ...directive, voice: undefined }),
		});
		last().emit("message", { data: JSON.stringify({ type: "other" }) });
		expect(apply).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(3);
		handle.stop();
	});

	it("ほかのパートナー宛ての指示は捨てる", () => {
		const { last, apply, handle } = setup();
		last().emit("open");
		last().emit("message", {
			data: JSON.stringify({ ...directive, partner_id: "akarin" }),
		});
		expect(apply).not.toHaveBeenCalled();
		handle.stop();
	});

	it("開いているあいだ ping を一定間隔で送る", () => {
		const { last, handle } = setup();
		last().emit("open");
		vi.advanceTimersByTime(PING_INTERVAL_MS * 2);
		expect(last().sent).toEqual([PING, PING]);
		handle.stop();
		vi.advanceTimersByTime(PING_INTERVAL_MS);
		expect(last().sent).toEqual([PING, PING]);
	});

	it("切れたら待ち時間を倍にしながらつなぎ直す", () => {
		const { sockets, last, handle } = setup();
		last().emit("close");
		vi.advanceTimersByTime(999);
		expect(sockets).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(2);
		last().emit("error");
		expect(sockets[1]?.closed).toBe(true);
		vi.advanceTimersByTime(1999);
		expect(sockets).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(sockets).toHaveLength(3);
		handle.stop();
	});

	it("error に続く close では、つなぎ直しを 1 回だけ予約する", () => {
		const { sockets, last, handle } = setup();
		const first = last();
		first.emit("error");
		first.emit("close");
		vi.advanceTimersByTime(1000);
		expect(sockets).toHaveLength(2);
		vi.advanceTimersByTime(60_000);
		expect(sockets).toHaveLength(2);
		handle.stop();
	});

	it("安定してつながったあとに切れたら、最初の待ち時間に戻す", () => {
		const { sockets, last, handle } = setup();
		last().emit("close");
		vi.advanceTimersByTime(1000);
		last().emit("close");
		vi.advanceTimersByTime(2000);
		expect(sockets).toHaveLength(3);
		last().emit("open");
		vi.advanceTimersByTime(60_000);
		last().emit("close");
		vi.advanceTimersByTime(1000);
		expect(sockets).toHaveLength(4);
		handle.stop();
	});

	it("stop() のあとは閉じてつなぎ直さない", () => {
		const { sockets, last, handle } = setup();
		last().emit("open");
		handle.stop();
		expect(last().closed).toBe(true);
		last().emit("close");
		vi.advanceTimersByTime(BACKOFF_ENOUGH);
		expect(sockets).toHaveLength(1);
	});

	it("つなぎ直しを待っているあいだに stop() したら、予約を取り消す", () => {
		const { sockets, last, handle } = setup();
		last().emit("close");
		handle.stop();
		vi.advanceTimersByTime(BACKOFF_ENOUGH);
		expect(sockets).toHaveLength(1);
	});
});

describe("backoffMs", () => {
	it("上限で止まり、揺らぎは上限の後半に収まる", () => {
		expect(backoffMs(0, () => 0)).toBe(500);
		expect(backoffMs(3, () => 0.999999)).toBe(8000);
		expect(backoffMs(20, () => 0)).toBe(30_000);
		expect(backoffMs(20, () => 0.999999)).toBe(60_000);
	});
});
