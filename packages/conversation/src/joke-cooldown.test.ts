import { describe, expect, it } from "vitest";
import { isJokeAvailable, jokeStatusOf } from "./joke-cooldown.ts";

const now = new Date("2026-01-10T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

describe("isJokeAvailable", () => {
	it("未使用なら使える", () => {
		expect(isJokeAvailable(null, 60, now)).toBe(true);
		expect(isJokeAvailable(undefined, 60, now)).toBe(true);
	});

	it("cooldown 内は使えない", () => {
		expect(isJokeAvailable(minutesAgo(59), 60, now)).toBe(false);
		expect(isJokeAvailable(now, 60, now)).toBe(false);
	});

	it("ちょうど cooldown 分経過で使える", () => {
		expect(isJokeAvailable(minutesAgo(60), 60, now)).toBe(true);
		expect(isJokeAvailable(minutesAgo(61), 60, now)).toBe(true);
	});

	it("cooldown 0 は常に使える", () => {
		expect(isJokeAvailable(now, 0, now)).toBe(true);
	});

	it("時計が戻って last が未来になっても使えるとはしない", () => {
		expect(isJokeAvailable(new Date(now.getTime() + 1000), 60, now)).toBe(
			false,
		);
	});
});

describe("jokeStatusOf", () => {
	it("PromptBuilder 用の状態に変換する", () => {
		expect(jokeStatusOf(minutesAgo(10), 60, now)).toBe("cooling_down");
		expect(jokeStatusOf(minutesAgo(90), 60, now)).toBe("available");
	});
});
