import { jstDayNumber, toJstDate } from "@yunomi/core";
import type { Logger } from "./logger.ts";
import type {
	SeatStatusClient,
	SeatSummary,
	Usage,
	UsageWindow,
} from "./seat-status-client.ts";

export const WORK_ACTIVITY_INTERVAL_MS = 60_000;
export const USAGE_BIO_INTERVAL_MS = 15 * 60_000;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const MINUTE_MS = 60_000;

const clock = (at: Date): string => {
	const d = toJstDate(at);
	return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

/**
 * リセット時刻。今日なら時刻だけ、別の日なら曜日を付ける。どちらの枠も 7 日以内に戻るので、日付は書かなくても読める。
 * API は 18:59:59 や 19:00:00.6 のように前後にぶれた値を返すので、近いほうの分に丸めて 19:00 と書く。
 */
const resetLabel = (resetsAt: number, now: Date): string => {
	const at = new Date(Math.round(resetsAt / MINUTE_MS) * MINUTE_MS);
	if (jstDayNumber(at) === jstDayNumber(now)) return clock(at);
	return `${WEEKDAYS[toJstDate(at).getUTCDay()]} ${clock(at)}`;
};

const percent = (w: UsageWindow) => `${Math.round(w.usedPercent)}%`;

/** bot のステータスに出す文。作業中の席も使用率もなければ出さない。 */
export const workActivityText = (summary: SeatSummary): string | null => {
	const parts: string[] = [];
	if (summary.working > 0) parts.push(`作業中 ${summary.working}件`);
	if (summary.usage) {
		parts.push(
			`5h ${percent(summary.usage.fiveHour)}`,
			`週 ${percent(summary.usage.weekly)}`,
		);
	}
	return parts.length > 0 ? parts.join(" · ") : null;
};

const GAUGE_CELLS = 5;

// 全部埋まるのは 100% のときだけにしたいので切り捨てる。表示の % と食い違わないよう、丸めた値から数える
const gauge = (w: UsageWindow): string => {
	const filled = Math.min(
		GAUGE_CELLS,
		Math.max(0, Math.floor((Math.round(w.usedPercent) * GAUGE_CELLS) / 100)),
	);
	return "▰".repeat(filled) + "▱".repeat(GAUGE_CELLS - filled);
};

const usageLine = (label: string, w: UsageWindow, now: Date): string => {
	const reset = w.resetsAt == null ? "" : `・${resetLabel(w.resetsAt, now)}`;
	return `${label} ${gauge(w)} ${percent(w)}${reset}`;
};

/**
 * 自己紹介欄に出す使用率の本文。読めていなければ空にする。
 * プロフィールの小窓は頭の 3 行しか出さず、長い行は欄の幅で切れるので、1 枠 1 行に短く収める。
 */
export const usageBioBody = (usage: Usage | null, now: Date): string =>
	usage
		? [
				usageLine("5h", usage.fiveHour, now),
				usageLine("W", usage.weekly, now),
			].join("\n")
		: "";

type WorkActivityOptions = {
	seatStatus: Pick<SeatStatusClient, "seatSummary">;
	/** null で消す。 */
	setActivity: (text: string | null) => void;
	/** 自己紹介欄を書き換える。失敗したら false。 */
	setBio?: (text: string) => Promise<boolean>;
	logger: Logger;
	intervalMs?: number;
	bioIntervalMs?: number;
	now?: () => Date;
};

/**
 * mizuya の Working から作業中の席の数と使用率を読み、bot のステータスと自己紹介欄に出し続ける。止める関数を返す。
 * 自己紹介欄はアプリの説明文で、書き換えの頻度の制限が公開されていない。本文が変わったときだけ、bioIntervalMs に一度まで書く。
 */
export const startWorkActivity = (opts: WorkActivityOptions): (() => void) => {
	const now = opts.now ?? (() => new Date());
	const bioIntervalMs = opts.bioIntervalMs ?? USAGE_BIO_INTERVAL_MS;
	let shown: string | null = null;
	let bioShown: string | null = null;
	let bioWrittenAt = Number.NEGATIVE_INFINITY;
	let bioWriting = false;
	const updateBio = async (usage: Usage | null) => {
		if (!opts.setBio || bioWriting) return;
		const at = now();
		const body = usageBioBody(usage, at);
		// 起動直後は Working がまだ使用率を読めていないことが多い。空で書くと次に書けるまで待たされる
		if (body === "" && bioShown === null) return;
		if (body === bioShown || at.getTime() - bioWrittenAt < bioIntervalMs) {
			return;
		}
		// 何分前の値かが分かるよう、書いた時刻を添える
		const text = body === "" ? "" : `${body}\n${clock(at)} 時点`;
		bioWriting = true;
		const written = await opts.setBio(text);
		bioWriting = false;
		if (!written) return;
		bioShown = body;
		bioWrittenAt = at.getTime();
	};
	const update = async () => {
		const r = await opts.seatStatus.seatSummary();
		if (!r.ok) {
			opts.logger.debug("seat summary unavailable", { error: r.error.type });
		}
		// 読めないときは古い数を出したままにしない
		const text = r.ok ? workActivityText(r.value) : null;
		if (text !== shown) {
			shown = text;
			opts.setActivity(text);
		}
		// Working が一時的に読めないだけで消すと、次に書けるまで空のままになる
		if (r.ok) await updateBio(r.value.usage);
	};
	void update();
	const timer = setInterval(
		() => void update(),
		opts.intervalMs ?? WORK_ACTIVITY_INTERVAL_MS,
	);
	timer.unref();
	return () => clearInterval(timer);
};
