import { toJstDate } from "@yunomi/core";
import type { Logger } from "./logger.ts";

export type TimeOfDay = { hour: number; minute: number };

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `now` より後で、いちばん近い平日（月〜金、JST）の `at`（JST）。祝日は見ない。 */
export const nextStandupAt = (now: Date, at: TimeOfDay): Date => {
	const jst = toJstDate(now);
	const midnightUtc =
		Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) -
		JST_OFFSET_MS;
	for (let d = 0; d < 8; d++) {
		const candidate = new Date(
			midnightUtc + d * DAY_MS + (at.hour * 60 + at.minute) * 60_000,
		);
		const weekday = toJstDate(candidate).getUTCDay();
		if (candidate > now && weekday !== 0 && weekday !== 6) return candidate;
	}
	throw new Error("unreachable: 8 日以内に平日がある");
};

export type TimerDeps = {
	at: TimeOfDay;
	run: () => Promise<void>;
	now?: () => Date;
	setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
	logger: Logger;
};

const defaultSetTimer = (fn: () => void, ms: number) => {
	const t = setTimeout(fn, ms);
	return { cancel: () => clearTimeout(t) };
};

/** 平日の朝会を回す。1 回が終わってから次を予約するので、長引いても重ならない。 */
export const startStandupTimer = (deps: TimerDeps): { stop: () => void } => {
	const now = deps.now ?? (() => new Date());
	const setTimer = deps.setTimer ?? defaultSetTimer;
	let current: { cancel: () => void } | null = null;
	let stopped = false;

	const schedule = () => {
		if (stopped) return;
		const at = nextStandupAt(now(), deps.at);
		deps.logger.info("standup scheduled", { at: at.getTime() });
		current = setTimer(
			() => {
				void deps
					.run()
					.catch((e: unknown) =>
						deps.logger.error("standup crashed", { error: String(e) }),
					)
					.finally(schedule);
			},
			Math.max(0, at.getTime() - now().getTime()),
		);
	};
	schedule();
	return {
		stop: () => {
			stopped = true;
			current?.cancel();
		},
	};
};
