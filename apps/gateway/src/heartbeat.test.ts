import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHeartbeat } from "./heartbeat.ts";

describe("startHeartbeat", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("ready の間は即時と interval ごとに timestamp を書く", () => {
		const write = vi.fn();
		const stop = startHeartbeat({
			path: "/hb",
			isReady: () => true,
			intervalMs: 30_000,
			now: () => new Date("2026-01-01T00:00:00.000Z"),
			write,
		});
		expect(write).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledWith("/hb", "2026-01-01T00:00:00.000Z");
		vi.advanceTimersByTime(60_000);
		expect(write).toHaveBeenCalledTimes(3);
		stop();
	});

	it("ready でない間は書かず、ready になると書く", () => {
		const write = vi.fn();
		let ready = false;
		const stop = startHeartbeat({
			path: "/hb",
			isReady: () => ready,
			intervalMs: 30_000,
			write,
		});
		vi.advanceTimersByTime(30_000);
		expect(write).not.toHaveBeenCalled();
		ready = true;
		vi.advanceTimersByTime(30_000);
		expect(write).toHaveBeenCalledTimes(1);
		stop();
	});

	it("stop 後は書かない", () => {
		const write = vi.fn();
		const stop = startHeartbeat({
			path: "/hb",
			isReady: () => true,
			intervalMs: 1000,
			write,
		});
		stop();
		write.mockClear();
		vi.advanceTimersByTime(5000);
		expect(write).not.toHaveBeenCalled();
	});

	it("書き込み失敗は握りつぶして継続する", () => {
		const write = vi.fn(() => {
			throw new Error("EROFS");
		});
		const stop = startHeartbeat({
			path: "/hb",
			isReady: () => true,
			intervalMs: 1000,
			write,
		});
		expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
		stop();
	});
});
