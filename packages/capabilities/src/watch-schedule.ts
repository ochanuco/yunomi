import { err, ok, type Result } from "@yunomi/core";
import { Cron } from "croner";

/** 持ち主の暮らしの時刻で書くので、cron 式は日本時間で読む。 */
export const WATCH_SCHEDULE_TIMEZONE = "Asia/Tokyo";
/** 席が 1 回動くたびに Claude のセッションが立つので、発火の間隔はこれより詰めさせない（費用の歯止め）。 */
export const WATCH_SCHEDULE_MIN_GAP_MINUTES = 30;
// 日をまたぐ間隔や、曜日・日付で間引いた式も拾えるだけ先まで並べる。妥当な式は 30 分以上空くので、この回数で 10 日以上を覆う。
const GAP_CHECK_RUNS = 500;
const GAP_CHECK_HORIZON_MS = 400 * 24 * 60 * 60_000;

// 秒の項目、@daily のような別名、L・W・# や曜日・月の名前は受け付けない。Working が Dkron のジョブに写すので、5 項目の数字だけに絞る。
const FIELD = /^[0-9*,/-]+$/;

const cron = (schedule: string): Cron | null => {
	const fields = schedule.trim().split(/\s+/);
	if (fields.length !== 5 || !fields.every((f) => FIELD.test(f))) return null;
	try {
		return new Cron(fields.join(" "), {
			timezone: WATCH_SCHEDULE_TIMEZONE,
			paused: true,
		});
	} catch {
		return null;
	}
};

/** 見張りの cron 式を確かめ、項目の間の空白を 1 つにそろえて返す。通らなければ理由を返す。 */
export const checkWatchSchedule = (
	schedule: string,
	now: Date,
): Result<string, string> => {
	const c = cron(schedule);
	if (c === null) {
		return err("5 項目（分 時 日 月 曜日）の数字と * , - / だけで書く");
	}
	const horizon = now.getTime() + GAP_CHECK_HORIZON_MS;
	let prev = c.nextRun(now);
	if (prev === null) return err("一度も動かない");
	for (let i = 1; i < GAP_CHECK_RUNS; i++) {
		const next = c.nextRun(prev);
		if (next === null || next.getTime() > horizon) break;
		if (
			next.getTime() - prev.getTime() <
			WATCH_SCHEDULE_MIN_GAP_MINUTES * 60_000
		) {
			return err(`${WATCH_SCHEDULE_MIN_GAP_MINUTES} 分より短い間隔で動く`);
		}
		prev = next;
	}
	return ok(schedule.trim().split(/\s+/).join(" "));
};

/** after より後、at まで（at を含む）に cron 式の発火時刻が 1 回以上あるか。読めない式は false。 */
export const watchScheduleFiredBetween = (
	schedule: string,
	after: Date,
	at: Date,
): boolean => {
	const next = cron(schedule)?.nextRun(after) ?? null;
	return next !== null && next.getTime() <= at.getTime();
};
