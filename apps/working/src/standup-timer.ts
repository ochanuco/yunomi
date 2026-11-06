import { toJstDate } from "@yunomi/core";
import type { Logger } from "./logger.ts";

export type TimeOfDay = { hour: number; minute: number };

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `now` より後で、いちばん近い `at`（JST）。曜日は見ない（個人開発なので毎日開く）。 */
export const nextStandupAt = (now: Date, at: TimeOfDay): Date => {
	const jst = toJstDate(now);
	const midnightUtc =
		Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) -
		JST_OFFSET_MS;
	const today = new Date(midnightUtc + (at.hour * 60 + at.minute) * 60_000);
	return today > now ? today : new Date(today.getTime() + DAY_MS);
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

/** 毎日の朝会を回す。1 回が終わってから次を予約するので、長引いても重ならない。 */
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
