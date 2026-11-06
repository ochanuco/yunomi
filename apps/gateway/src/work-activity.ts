import { jstDayNumber, toJstDate } from "@yunomi/core";
import type { Logger } from "./logger.ts";
import type {
	SeatSummary,
	UsageWindow,
	WorkingClient,
} from "./working-client.ts";

export const WORK_ACTIVITY_INTERVAL_MS = 60_000;

// Discord のカスタムステータスの上限
const ACTIVITY_MAX_LENGTH = 128;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** リセット時刻。今日なら時刻だけ、別の日なら日付と曜日を付ける。 */
const resetLabel = (at: number, now: Date): string => {
	const d = toJstDate(new Date(at));
	const time = `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
	if (jstDayNumber(new Date(at)) === jstDayNumber(now)) return time;
	return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAYS[d.getUTCDay()]}) ${time}`;
};

const percent = (w: UsageWindow) => `${Math.round(w.usedPercent)}%`;

/**
 * bot のステータスに出す文。作業中の席も使用率もなければ出さない。
 * メンバー一覧では頭しか見えないので、数字を先に、リセット時刻を後ろに置く。プロフィールを開けば全文が見える。
 */
export const workActivityText = (
	summary: SeatSummary,
	now: Date,
): string | null => {
	const head: string[] = [];
	if (summary.working > 0) head.push(`作業中 ${summary.working}件`);
	const { usage } = summary;
	if (usage) {
		head.push(`5h ${percent(usage.fiveHour)}`, `週 ${percent(usage.weekly)}`);
	}
	if (head.length === 0) return null;
	const resets: string[] = [];
	if (usage?.fiveHour.resetsAt != null) {
		resets.push(`5h は ${resetLabel(usage.fiveHour.resetsAt, now)}`);
	}
	if (usage?.weekly.resetsAt != null) {
		resets.push(`週は ${resetLabel(usage.weekly.resetsAt, now)}`);
	}
	const text =
		resets.length > 0
			? `${head.join(" · ")} ｜ ${resets.join("、")} に戻る`
			: head.join(" · ");
	return text.slice(0, ACTIVITY_MAX_LENGTH);
};

type WorkActivityOptions = {
	working: Pick<WorkingClient, "seatSummary">;
	/** null で消す。 */
	setActivity: (text: string | null) => void;
	logger: Logger;
	intervalMs?: number;
	now?: () => Date;
};

/** 受付から作業中の席の数と使用率を読み、bot のステータスに出し続ける。止める関数を返す。 */
export const startWorkActivity = (opts: WorkActivityOptions): (() => void) => {
	const now = opts.now ?? (() => new Date());
	let shown: string | null = null;
	const update = async () => {
		const r = await opts.working.seatSummary();
		if (!r.ok) {
			opts.logger.debug("seat summary unavailable", { error: r.error.type });
		}
		// 読めないときは古い数を出したままにしない
		const text = r.ok ? workActivityText(r.value, now()) : null;
		if (text === shown) return;
		shown = text;
		opts.setActivity(text);
	};
	void update();
	const timer = setInterval(
		() => void update(),
		opts.intervalMs ?? WORK_ACTIVITY_INTERVAL_MS,
	);
	timer.unref();
	return () => clearInterval(timer);
};
