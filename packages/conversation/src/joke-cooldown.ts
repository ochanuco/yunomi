import type { JokeStatus } from "./prompt-builder.ts";

/** 未使用（null / undefined）か、最後の使用から cooldown 分以上経っていれば使える。ちょうど境界は使える側。 */
export const isJokeAvailable = (
	lastUsedAt: Date | null | undefined,
	cooldownMinutes: number,
	now: Date,
): boolean => {
	if (!lastUsedAt) return true;
	return now.getTime() - lastUsedAt.getTime() >= cooldownMinutes * 60_000;
};

export const jokeStatusOf = (
	lastUsedAt: Date | null | undefined,
	cooldownMinutes: number,
	now: Date,
): JokeStatus =>
	isJokeAvailable(lastUsedAt, cooldownMinutes, now)
		? "available"
		: "cooling_down";
