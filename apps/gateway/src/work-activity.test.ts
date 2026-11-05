import { err, externalServiceUnavailable, ok } from "@yunomi/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "./logger.ts";
import { startWorkActivity, workActivityText } from "./work-activity.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("workActivityText", () => {
	it("作業中の席がなければ出さない", () => {
		expect(workActivityText(0)).toBeNull();
		expect(workActivityText(3)).toBe("作業中 3件");
	});
});

describe("startWorkActivity", () => {
	it("1 分おきに席の数を読み、変わったときだけステータスを書き換え、読めなければ消す", async () => {
		vi.useFakeTimers();
		const answers = [
			ok({ working: 2 }),
			ok({ working: 2 }),
			err(externalServiceUnavailable({ service: "working" })),
			ok({ working: 0 }),
			ok({ working: 1 }),
		];
		const seatSummary = vi.fn(
			async () => answers.shift() ?? ok({ working: 0 }),
		);
		const setActivity = vi.fn<(text: string | null) => void>();
		const stop = startWorkActivity({
			working: { seatSummary },
			setActivity,
			logger: silentLogger,
		});
		for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(60_000);
		stop();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(seatSummary).toHaveBeenCalledTimes(5);
		expect(setActivity.mock.calls.map(([t]) => t)).toEqual([
			"作業中 2件",
			null,
			"作業中 1件",
		]);
	});
});
