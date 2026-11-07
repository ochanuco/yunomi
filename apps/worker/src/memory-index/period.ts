import { jstDayNumber, toJstDate } from "@yunomi/core";

/** 発言の期間の表現を直した範囲。from を含み、to を含まない。 */
export type RecallPeriod = { from: Date; to: Date };

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JST の暦日の通し番号を、その日の JST 0 時に直す。 */
const dayStart = (day: number): Date => new Date(day * DAY_MS - JST_OFFSET_MS);

/** JST の年月日（月は 1 始まり、範囲外は Date.UTC と同じく繰り上がる）の 0 時。 */
const jstMidnight = (year: number, month: number, date = 1): Date =>
	new Date(Date.UTC(year, month - 1, date) - JST_OFFSET_MS);

const dayOf = (year: number, month: number, date: number): number =>
	jstDayNumber(jstMidnight(year, month, date));

/** 暦日の通し番号を、その日付を UTC のフィールドに持つ Date にする。曜日と年を読む用。 */
const calendar = (day: number): Date => new Date(day * DAY_MS);

const days = (from: number, toExclusive: number): RecallPeriod => ({
	from: dayStart(from),
	to: dayStart(toExclusive),
});

type Clock = { now: Date; year: number; month: number; today: number };

type YearRef =
	| { type: "none" }
	| { type: "this" }
	| { type: "offset"; years: number }
	| { type: "absolute"; year: number };

type YearlyPeriod = (year: number) => RecallPeriod;

/**
 * 年ごとに決まる期間を、年の言い方に合わせて 1 つ選ぶ。
 * 年の指定が無いか「今年」なら、始まっている中で最も新しいものにする。思い出す対象は過去にしかないため。
 */
const resolveYearly = (
	ref: YearRef,
	clock: Clock,
	period: YearlyPeriod,
): RecallPeriod => {
	switch (ref.type) {
		case "offset":
			return period(clock.year - ref.years);
		case "absolute":
			return period(ref.year);
		default: {
			const current = period(clock.year);
			return current.from > clock.now ? period(clock.year - 1) : current;
		}
	}
};

const YEAR_PREFIX =
	"(?:(一昨年|おととし|去年|昨年|今年|この|(\\d{4})年|(\\d+)年前)の?)";

const yearRef = (m: RegExpExecArray): YearRef => {
	const [, word, absolute, ago] = m;
	if (absolute) return { type: "absolute", year: Number(absolute) };
	if (ago) return { type: "offset", years: Number(ago) };
	switch (word) {
		case "一昨年":
		case "おととし":
			return { type: "offset", years: 2 };
		case "去年":
		case "昨年":
			return { type: "offset", years: 1 };
		case "今年":
		case "この":
			return { type: "this" };
		default:
			return { type: "none" };
	}
};

const SEASONS: Record<string, YearlyPeriod> = {
	春: (y) => ({ from: jstMidnight(y, 3), to: jstMidnight(y, 6) }),
	夏: (y) => ({ from: jstMidnight(y, 6), to: jstMidnight(y, 9) }),
	秋: (y) => ({ from: jstMidnight(y, 9), to: jstMidnight(y, 12) }),
	// 冬はその年の 12 月に始まる冬とする。「去年の冬」はふつう、去年の暮れから今年の初めを指す。
	冬: (y) => ({ from: jstMidnight(y, 12), to: jstMidnight(y + 1, 3) }),
};

// 長い休みは世間一般の目安の幅で引く。厳密な日付より、取りこぼさないことを優先する。
const HOLIDAYS: Record<string, YearlyPeriod> = {
	ゴールデンウィーク: (y) => days(dayOf(y, 4, 26), dayOf(y, 5, 8)),
	GW: (y) => days(dayOf(y, 4, 26), dayOf(y, 5, 8)),
	お盆: (y) => days(dayOf(y, 8, 8), dayOf(y, 8, 18)),
	春休み: (y) => days(dayOf(y, 3, 15), dayOf(y, 4, 10)),
	夏休み: (y) => days(dayOf(y, 7, 15), dayOf(y, 9, 1)),
	冬休み: (y) => days(dayOf(y, 12, 20), dayOf(y + 1, 1, 10)),
	年末年始: (y) => days(dayOf(y, 12, 25), dayOf(y + 1, 1, 6)),
	年末: (y) => days(dayOf(y, 12, 15), dayOf(y + 1, 1, 1)),
	正月: (y) => days(dayOf(y, 1, 1), dayOf(y, 1, 8)),
	お正月: (y) => days(dayOf(y, 1, 1), dayOf(y, 1, 8)),
};

// 春分・秋分の日は官報の公示を待たず、1980〜2099 年で通用する近似式で求める。
const equinox = (year: number, base: number): number =>
	Math.floor(base + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));

const nthMonday = (year: number, month: number, n: number): number => {
	const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
	return 1 + ((8 - first) % 7) + (n - 1) * 7;
};

const holidayCache = new Map<number, Set<number>>();

/** 国民の祝日（振替休日と国民の休日を含む）と、年末年始の休み。 */
const offDaysOf = (year: number): Set<number> => {
	const cached = holidayCache.get(year);
	if (cached) return cached;
	const holidays = new Set<number>(
		(
			[
				[1, 1],
				[1, nthMonday(year, 1, 2)],
				[2, 11],
				[2, 23],
				[3, equinox(year, 20.8431)],
				[4, 29],
				[5, 3],
				[5, 4],
				[5, 5],
				[7, nthMonday(year, 7, 3)],
				[8, 11],
				[9, nthMonday(year, 9, 3)],
				[9, equinox(year, 23.2488)],
				[10, nthMonday(year, 10, 2)],
				[11, 3],
				[11, 23],
			] as const
		).map(([m, d]) => dayOf(year, m, d)),
	);
	const weekday = (day: number) => calendar(day).getUTCDay();
	for (const day of [...holidays].sort((a, b) => a - b)) {
		if (weekday(day) !== 0) continue;
		let substitute = day + 1;
		while (holidays.has(substitute)) substitute += 1;
		holidays.add(substitute);
	}
	for (const day of [...holidays]) {
		if (holidays.has(day + 2) && !holidays.has(day + 1)) {
			if (weekday(day + 1) !== 0) holidays.add(day + 1);
		}
	}
	for (const [m, d] of [
		[1, 2],
		[1, 3],
		[12, 29],
		[12, 30],
		[12, 31],
	] as const) {
		holidays.add(dayOf(year, m, d));
	}
	holidayCache.set(year, holidays);
	return holidays;
};

const isOffDay = (day: number): boolean => {
	const date = calendar(day);
	const weekday = date.getUTCDay();
	if (weekday === 0 || weekday === 6) return true;
	return offDaysOf(date.getUTCFullYear()).has(day);
};

/** 連休とみなす休みの日数。 */
const LONG_WEEKEND_DAYS = 3;
const LONG_WEEKEND_LOOKBACK_DAYS = 400;

/** 終わった中で最も新しい連休。今日が休みの続きなら、その連休はまだ「この前」ではないので飛ばす。 */
const lastLongWeekend = (today: number): RecallPeriod | null => {
	let day = today - 1;
	if (isOffDay(today)) while (isOffDay(day)) day -= 1;
	const stop = today - LONG_WEEKEND_LOOKBACK_DAYS;
	while (day > stop) {
		if (!isOffDay(day)) {
			day -= 1;
			continue;
		}
		const end = day;
		while (isOffDay(day)) day -= 1;
		if (end - day >= LONG_WEEKEND_DAYS) return days(day + 1, end + 1);
	}
	return null;
};

const mondayOf = (clock: Clock): number =>
	clock.today - ((toJstDate(clock.now).getUTCDay() + 6) % 7);

const monthPeriod = (year: number, month: number): RecallPeriod => ({
	from: jstMidnight(year, month),
	to: jstMidnight(year, month + 1),
});

type Rule = {
	pattern: RegExp;
	resolve: (m: RegExpExecArray, clock: Clock) => RecallPeriod | null;
};

const alternatives = (words: readonly string[]) =>
	[...words].sort((a, b) => b.length - a.length).join("|");

const RULES: Rule[] = [
	{
		pattern: new RegExp(
			`${YEAR_PREFIX}?(${alternatives(Object.keys(HOLIDAYS))})`,
		),
		resolve: (m, c) => {
			const period = HOLIDAYS[m[4] ?? ""];
			return period ? resolveYearly(yearRef(m), c, period) : null;
		},
	},
	{
		// 季節は「去年の春」のように年を添えたときだけ読む。単独の「春」は「春雨」などに紛れる。
		pattern: new RegExp(`${YEAR_PREFIX}(春|夏|秋|冬)`),
		resolve: (m, c) => {
			const period = SEASONS[m[4] ?? ""];
			return period ? resolveYearly(yearRef(m), c, period) : null;
		},
	},
	{
		pattern: new RegExp(`${YEAR_PREFIX}?(\\d{1,2})月(?:(\\d{1,2})日)?`),
		resolve: (m, c) => {
			const month = Number(m[4]);
			if (month < 1 || month > 12) return null;
			const date = m[5] ? Number(m[5]) : null;
			if (date !== null && (date < 1 || date > 31)) return null;
			return resolveYearly(yearRef(m), c, (y) =>
				date === null
					? monthPeriod(y, month)
					: days(dayOf(y, month, date), dayOf(y, month, date) + 1),
			);
		},
	},
	{
		pattern: /(この前|前|こないだ|この間|先日|先月|先週)の連休/,
		resolve: (_m, c) => lastLongWeekend(c.today),
	},
	{
		pattern: /先週末/,
		resolve: (_m, c) => days(mondayOf(c) - 2, mondayOf(c)),
	},
	{
		pattern: /(先々週|先週|今週)/,
		resolve: (m, c) => {
			const offset = { 先々週: -2, 先週: -1, 今週: 0 }[m[1] ?? ""];
			if (offset === undefined) return null;
			const monday = mondayOf(c) + offset * 7;
			return days(monday, monday + 7);
		},
	},
	{
		pattern: /(先々月|先月|今月)/,
		resolve: (m, c) => {
			const offset = { 先々月: -2, 先月: -1, 今月: 0 }[m[1] ?? ""] ?? 0;
			return monthPeriod(c.year, c.month + offset);
		},
	},
	{
		// 「3日前」「2週間前」「半年前」はどれも言い方がおおまかなので、前後に幅を持たせる。
		pattern: /(\d+)(日|週間|か月|ヶ月|カ月|ケ月)前/,
		resolve: (m, c) => {
			const n = Number(m[1]);
			if (m[2] === "日") return days(c.today - n - 1, c.today - n + 2);
			if (m[2] === "週間")
				return days(c.today - (n + 1) * 7, c.today - (n - 1) * 7 + 1);
			return {
				from: jstMidnight(c.year, c.month - n - 1),
				to: jstMidnight(c.year, c.month - n + 2),
			};
		},
	},
	{
		pattern: /半年前/,
		resolve: (_m, c) => ({
			from: jstMidnight(c.year, c.month - 8),
			to: jstMidnight(c.year, c.month - 3),
		}),
	},
	{
		pattern: /(一昨年|おととし|去年|昨年|今年|(\d{4})年|(\d+)年前)/,
		resolve: (m, c) => {
			const ref = yearRef(m);
			const year =
				ref.type === "absolute"
					? ref.year
					: ref.type === "offset"
						? c.year - ref.years
						: c.year;
			return { from: jstMidnight(year, 1), to: jstMidnight(year + 1, 1) };
		},
	},
	{
		// 「今日」は読まない。今日の話は直近ログにあり、絞ると昔の記憶が浮かばなくなる。
		pattern: /(一昨日|おととい|昨日|きのう|昨夜|昨晩|ゆうべ)/,
		resolve: (m, c) => {
			const back = m[1] === "一昨日" || m[1] === "おととい" ? 2 : 1;
			return days(c.today - back, c.today - back + 1);
		},
	},
];

/**
 * 1 つの発言から期間の表現を読む。最も前に出てくる表現を採り、同じ位置なら長い方（「去年の春」と「去年」なら前者）にする。
 * モデルに解釈させず、決まった規則だけで読む。読めなければ null。
 */
export const parsePeriod = (text: string, now: Date): RecallPeriod | null => {
	const normalized = text.normalize("NFKC");
	const jst = toJstDate(now);
	const clock: Clock = {
		now,
		year: jst.getUTCFullYear(),
		month: jst.getUTCMonth() + 1,
		today: jstDayNumber(now),
	};
	let best: { index: number; length: number; period: RecallPeriod } | null =
		null;
	for (const rule of RULES) {
		const m = rule.pattern.exec(normalized);
		if (!m) continue;
		const better =
			best === null ||
			m.index < best.index ||
			(m.index === best.index && m[0].length > best.length);
		if (!better) continue;
		const period = rule.resolve(m, clock);
		if (period) best = { index: m.index, length: m[0].length, period };
	}
	return best?.period ?? null;
};

/** 新しい発言から順に読み、最初に見つかった期間を使う。 */
export const recallPeriod = (
	newestFirst: readonly string[],
	now: Date,
): RecallPeriod | null => {
	for (const text of newestFirst) {
		const period = parsePeriod(text, now);
		if (period) return period;
	}
	return null;
};
