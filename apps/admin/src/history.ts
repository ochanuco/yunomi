import {
	type RelationshipChangeView,
	STATE_HISTORY_DEFAULT_DAYS,
	type StateHistoryResponse,
	type StateValues,
} from "@yunomi/admin-contract";

export const HISTORY_DAYS = [1, 7, 30] as const;
export type HistoryDays = (typeof HISTORY_DAYS)[number];

export const parseDays = (raw: string | null): HistoryDays => {
	const n = Number(raw);
	return HISTORY_DAYS.find((d) => d === n) ?? STATE_HISTORY_DEFAULT_DAYS;
};

/** t は epoch ms。 */
export type Point = { t: number; v: number };
export type Span = { from: number; to: number };

export type NumericKey = "mood" | "energy" | "system_stress";

const ms = (iso: string) => Date.parse(iso);

/**
 * 値は遷移の時点で変わるので、変化の直前の値と直後の値を同じ時刻に置いて階段にする。
 * 開始点（since）から現在時刻まで伸ばす。
 */
const stepLine = (
	start: Point | null,
	changes: { t: number; before: number; after: number }[],
	until: number,
): Point[] => {
	const first = changes[0];
	const head = start ?? (first ? { t: first.t, v: first.before } : null);
	if (!head) return [];
	const points: Point[] = [head];
	for (const c of changes) {
		points.push({ t: c.t, v: c.before }, { t: c.t, v: c.after });
	}
	const last = points[points.length - 1] as Point;
	if (until > last.t) points.push({ t: until, v: last.v });
	return points;
};

export const stateSeries = (
	h: StateHistoryResponse,
	key: NumericKey,
	until: number,
): Point[] =>
	stepLine(
		h.state_at_start ? { t: ms(h.since), v: h.state_at_start[key] } : null,
		h.transitions.map((x) => ({
			t: ms(x.occurred_at),
			before: x.before[key],
			after: x.after[key],
		})),
		until,
	);

/** degraded_mode が true の区間。続いていれば until まで。 */
export const degradedSpans = (
	h: StateHistoryResponse,
	until: number,
): Span[] => {
	const spans: Span[] = [];
	let from: number | null = h.state_at_start?.degraded_mode
		? ms(h.since)
		: null;
	for (const x of h.transitions) {
		const t = ms(x.occurred_at);
		if (from === null && x.after.degraded_mode) from = t;
		else if (from !== null && !x.after.degraded_mode) {
			spans.push({ from, to: t });
			from = null;
		}
	}
	if (from !== null) spans.push({ from, to: Math.max(until, from) });
	return spans;
};

export type RelationshipSeries = {
	entityId: string;
	name: string;
	familiarity: Point[];
	trust: Point[];
};

/**
 * 相手ごとの系列。履歴が差分しか持たないため、最初の点は適用後の値から差分を引いて求める。
 * 期間内にイベントの無い相手は系列を作らない（現在値は上の表に出ている）。
 */
export const relationshipSeries = (
	h: StateHistoryResponse,
	until: number,
): RelationshipSeries[] => {
	const byEntity = new Map<string, RelationshipChangeView[]>();
	for (const e of h.relationships) {
		const list = byEntity.get(e.entity_id) ?? [];
		list.push(e);
		byEntity.set(e.entity_id, list);
	}
	const since = ms(h.since);
	return [...byEntity].map(([entityId, events]) => {
		const first = events[0] as RelationshipChangeView;
		const line = (
			startValue: number,
			pick: (e: RelationshipChangeView) => [after: number, delta: number],
		) =>
			stepLine(
				{ t: since, v: startValue },
				events.map((e) => {
					const [after, delta] = pick(e);
					return { t: ms(e.occurred_at), before: after - delta, after };
				}),
				until,
			);
		return {
			entityId,
			name: events.find((e) => e.display_name)?.display_name ?? entityId,
			familiarity: line(first.familiarity - first.familiarity_delta, (e) => [
				e.familiarity,
				e.familiarity_delta,
			]),
			trust: line(first.trust - first.trust_delta, (e) => [
				e.trust,
				e.trust_delta,
			]),
		};
	});
};

export type ChangeRow = {
	t: number;
	at: string;
	target: string;
	item: string;
	before: string;
	after: string;
	/** 数値項目のみ。 */
	diff: number | null;
	reason: string;
};

const NUMERIC_KEYS: NumericKey[] = ["mood", "energy", "system_stress"];
const OTHER_KEYS = ["presence", "degraded_mode"] as const;

const show = (n: number) => n.toFixed(2);

const stateRows = (h: StateHistoryResponse): ChangeRow[] =>
	h.transitions.flatMap((x) => {
		const base = {
			t: ms(x.occurred_at),
			at: x.occurred_at,
			target: "State",
			reason: x.reason,
		};
		const num = NUMERIC_KEYS.filter((k) => x.before[k] !== x.after[k]).map(
			(k): ChangeRow => ({
				...base,
				item: k,
				before: show(x.before[k]),
				after: show(x.after[k]),
				diff: x.after[k] - x.before[k],
			}),
		);
		const other = OTHER_KEYS.filter(
			(k: keyof StateValues) => x.before[k] !== x.after[k],
		).map(
			(k): ChangeRow => ({
				...base,
				item: k,
				before: String(x.before[k]),
				after: String(x.after[k]),
				diff: null,
			}),
		);
		return [...num, ...other];
	});

const relationshipRows = (h: StateHistoryResponse): ChangeRow[] =>
	h.relationships.flatMap((e) => {
		const base = {
			t: ms(e.occurred_at),
			at: e.occurred_at,
			target: e.display_name ?? e.entity_id,
			reason: e.summary ? `${e.reason} / ${e.summary}` : e.reason,
		};
		const row = (item: string, after: number, delta: number): ChangeRow[] =>
			delta === 0
				? []
				: [
						{
							...base,
							item,
							before: show(after - delta),
							after: show(after),
							diff: delta,
						},
					];
		return [
			...row("familiarity", e.familiarity, e.familiarity_delta),
			...row("trust", e.trust, e.trust_delta),
		];
	});

/** 新しい順。同時刻は State を先に並べた順のまま（安定ソート）。 */
export const changeRows = (
	h: StateHistoryResponse,
	limit: number,
): ChangeRow[] =>
	[...stateRows(h), ...relationshipRows(h)]
		.sort((a, b) => b.t - a.t)
		.slice(0, limit);
