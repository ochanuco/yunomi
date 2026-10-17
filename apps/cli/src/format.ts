import type {
	AuditItem,
	CandidateView,
	FactView,
	InterestView,
	KpiDay,
	OpenLoopView,
	OpinionView,
	RelationshipChangeView,
	RelationshipView,
	SnapshotSummary,
	StateHistoryResponse,
	StateTransitionView,
	StateValues,
	StatusResponse,
} from "@yunomi/admin-contract";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const jst = (iso: string | null): string => {
	if (iso === null) return "-";
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	return new Date(t + JST_OFFSET_MS)
		.toISOString()
		.replace("T", " ")
		.slice(0, 19);
};

const isWide = (cp: number) =>
	(cp >= 0x1100 && cp <= 0x115f) ||
	(cp >= 0x2e80 && cp <= 0xa4cf) ||
	(cp >= 0xac00 && cp <= 0xd7a3) ||
	(cp >= 0xf900 && cp <= 0xfaff) ||
	(cp >= 0xfe30 && cp <= 0xfe6f) ||
	(cp >= 0xff00 && cp <= 0xff60) ||
	(cp >= 0xffe0 && cp <= 0xffe6) ||
	(cp >= 0x1f300 && cp <= 0x1faff);

export const displayWidth = (s: string): number => {
	let w = 0;
	for (const ch of s) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
	return w;
};

/** 表示幅で切り、切ったときだけ末尾に … を付ける。改行は空白にする。 */
export const truncate = (raw: string, max: number): string => {
	const s = raw.replace(/\s+/g, " ");
	if (displayWidth(s) <= max) return s;
	let out = "";
	let w = 0;
	for (const ch of s) {
		const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
		if (w + cw > max - 1) break;
		out += ch;
		w += cw;
	}
	return `${out}…`;
};

const pad = (s: string, width: number) =>
	s + " ".repeat(Math.max(0, width - displayWidth(s)));

export const table = (header: string[], rows: string[][]): string => {
	const widths = header.map((h, i) =>
		Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ""))),
	);
	const line = (cells: string[]) =>
		cells
			.map((c, i) => pad(c, widths[i] ?? 0))
			.join("  ")
			.trimEnd();
	return [line(header), ...rows.map(line)].join("\n");
};

const num = (n: number) => n.toFixed(2);
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}`;

export const formatStatus = (
	s: StatusResponse,
	rels: RelationshipView[],
): string => {
	const lines = [
		`partner   ${s.partner_id} (${s.env}, profile v${s.profile_version})`,
	];
	if (s.state) {
		lines.push(
			`state     mood ${num(s.state.mood)}  energy ${num(s.state.energy)}  presence ${s.state.presence}  stress ${num(s.state.system_stress)}${s.state.degraded_mode ? "  DEGRADED" : ""}`,
			`          v${s.state.version}, updated ${jst(s.state.updated_at)} JST`,
		);
	} else {
		lines.push("state     (まだ無い)");
	}
	lines.push(
		`memory    facts ${s.counts.facts}, pending candidates ${s.counts.pending_candidates}`,
		`audit     last ${jst(s.last_audit_at)} JST`,
		"",
		rels.length === 0
			? "relationships: (なし)"
			: table(
					["RELATIONSHIP", "FAMILIARITY", "TRUST", "UPDATED (JST)"],
					rels.map((r) => [
						truncate(r.display_name ?? r.entity_id, 24),
						num(r.familiarity),
						num(r.trust),
						jst(r.updated_at),
					]),
				),
	);
	return lines.join("\n");
};

const factState = (f: FactView, now: Date) => {
	if (f.superseded_by) return "superseded";
	if (f.valid_to && Date.parse(f.valid_to) <= now.getTime()) return "expired";
	return "current";
};

export const formatFacts = (items: FactView[], now: Date): string =>
	items.length === 0
		? "(Fact なし)"
		: table(
				[
					"OBSERVED (JST)",
					"STATE",
					"PREDICATE",
					"VALUE",
					"CONF",
					"IMP",
					"SOURCE",
				],
				items.map((f) => [
					jst(f.observed_at),
					factState(f, now),
					truncate(f.predicate, 20),
					truncate(f.object_display ?? f.object_value, 30),
					num(f.confidence),
					num(f.importance),
					f.source,
				]),
			);

export const formatCandidates = (items: CandidateView[]): string =>
	items.length === 0
		? "(candidate なし)"
		: table(
				[
					"CREATED (JST)",
					"STATUS",
					"SUBJECT",
					"PREDICATE",
					"VALUE",
					"CONF",
					"SOURCE",
				],
				items.map((c) => [
					jst(c.created_at),
					c.status,
					truncate(c.subject_text ?? "(speaker)", 16),
					truncate(c.predicate, 20),
					truncate(c.object_value, 30),
					num(c.confidence),
					c.source,
				]),
			);

export const formatOpenLoops = (items: OpenLoopView[]): string =>
	items.length === 0
		? "(Open Loop なし)"
		: table(
				[
					"CREATED (JST)",
					"STATUS",
					"WHO",
					"SUMMARY",
					"IMP",
					"DUE (JST)",
					"DUE CONF",
				],
				items.map((l) => [
					jst(l.created_at),
					l.status,
					truncate(l.entity_display_name ?? l.entity_id, 16),
					truncate(l.summary, 40),
					num(l.importance),
					jst(l.due_at),
					l.due_confidence === null ? "-" : num(l.due_confidence),
				]),
			);

export const formatInterests = (items: InterestView[]): string =>
	items.length === 0
		? "(Interest なし)"
		: table(
				[
					"TOPIC",
					"LABEL",
					"SCORE",
					"BASELINE",
					"DELTA",
					"SOURCE",
					"UPDATED (JST)",
				],
				items.map((i) => [
					i.topic,
					truncate(i.label, 20),
					num(i.score),
					num(i.baseline),
					signed(i.learned_delta),
					i.source,
					jst(i.updated_at),
				]),
			);

export const formatOpinions = (items: OpinionView[]): string =>
	items.length === 0
		? "(Opinion なし)"
		: table(
				["TOPIC", "STANCE", "CONF", "STAB", "SOURCE", "UPDATED (JST)"],
				items.map((o) => [
					o.topic,
					truncate(o.stance, 60),
					num(o.confidence),
					num(o.stability),
					o.source,
					jst(o.updated_at),
				]),
			);

export const formatKpis = (items: KpiDay[]): string =>
	items.length === 0
		? "(KPI なし)"
		: table(
				[
					"DAY (JST)",
					"TURNS",
					"REPLY",
					"IGNORE",
					"ERR",
					"DEGR",
					"FALLBACK",
					"P50 MS",
					"P95 MS",
					"IN/OUT TOKENS",
					"CACHE R/W",
				],
				items.map((k) => [
					k.day,
					String(k.turns),
					String(k.replies),
					String(k.ignores),
					String(k.errors),
					String(k.degraded),
					String(k.fallback_used),
					k.latency_p50_ms === null ? "-" : String(k.latency_p50_ms),
					k.latency_p95_ms === null ? "-" : String(k.latency_p95_ms),
					`${k.usage.input_tokens}/${k.usage.output_tokens}`,
					`${k.usage.cache_read_tokens}/${k.usage.cache_write_tokens}`,
				]),
			);

type Param = {
	key: "mood" | "energy" | "system_stress";
	label: string;
};

const PARAMS: Param[] = [
	{ key: "mood", label: "mood" },
	{ key: "energy", label: "energy" },
	{ key: "system_stress", label: "system_stress" },
];

const range = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return `${num(sorted[0] ?? 0)} 〜 ${num(sorted.at(-1) ?? 0)}`;
};

const stateSummary = (h: StateHistoryResponse): string[] => {
	const first = h.transitions[0];
	const start = h.state_at_start ?? first?.before ?? null;
	const current = h.transitions.at(-1)?.after ?? start;
	if (!start || !current) return ["state: (まだ無い)"];
	const states: StateValues[] = [start, ...h.transitions.map((t) => t.after)];
	const rows = PARAMS.map((p) => [
		p.label,
		num(start[p.key]),
		"→",
		num(current[p.key]),
		`範囲 ${range(states.map((s) => s[p.key]))}`,
	]);
	rows.push([
		"degraded",
		String(start.degraded_mode),
		"→",
		String(current.degraded_mode),
		`${h.transitions.filter((t) => t.before.degraded_mode !== t.after.degraded_mode).length} 回切り替え`,
	]);
	rows.push(["presence", start.presence, "→", current.presence, ""]);
	return [table(["PARAM", "START", "", "NOW", ""], rows)];
};

const relationshipSummary = (h: StateHistoryResponse): string[] => {
	const byEntity = new Map<string, RelationshipChangeView[]>();
	for (const c of h.relationships) {
		byEntity.set(c.entity_id, [...(byEntity.get(c.entity_id) ?? []), c]);
	}
	if (byEntity.size === 0) return [];
	return [
		table(
			["RELATIONSHIP", "FAMILIARITY", "TRUST"],
			[...byEntity.values()].map((changes) => {
				const first = changes[0] as RelationshipChangeView;
				const last = changes.at(-1) as RelationshipChangeView;
				return [
					truncate(first.display_name ?? first.entity_id, 24),
					`${num(first.familiarity - first.familiarity_delta)} → ${num(last.familiarity)}`,
					`${num(first.trust - first.trust_delta)} → ${num(last.trust)}`,
				];
			}),
		),
	];
};

type ChangeRow = { at: string; cells: string[] };

const stateChanges = (t: StateTransitionView): ChangeRow[] => {
	const rows: ChangeRow[] = [];
	const add = (item: string, before: string, after: string, delta: string) =>
		rows.push({
			at: t.occurred_at,
			cells: [
				jst(t.occurred_at),
				"state",
				item,
				`${before} → ${after}`,
				delta,
				t.reason,
			],
		});
	for (const p of PARAMS) {
		if (t.before[p.key] !== t.after[p.key]) {
			add(
				p.label,
				num(t.before[p.key]),
				num(t.after[p.key]),
				signed(t.after[p.key] - t.before[p.key]),
			);
		}
	}
	if (t.before.degraded_mode !== t.after.degraded_mode) {
		add(
			"degraded",
			String(t.before.degraded_mode),
			String(t.after.degraded_mode),
			"",
		);
	}
	if (t.before.presence !== t.after.presence) {
		add("presence", t.before.presence, t.after.presence, "");
	}
	return rows;
};

const relationshipChanges = (c: RelationshipChangeView): ChangeRow[] => {
	const target = truncate(c.display_name ?? c.entity_id, 24);
	const reason = truncate(`${c.reason}: ${c.summary}`, 60);
	const rows: ChangeRow[] = [];
	const add = (item: string, now: number, delta: number) => {
		if (delta === 0) return;
		rows.push({
			at: c.occurred_at,
			cells: [
				jst(c.occurred_at),
				target,
				item,
				`${num(now - delta)} → ${num(now)}`,
				signed(delta),
				reason,
			],
		});
	};
	add("familiarity", c.familiarity, c.familiarity_delta);
	add("trust", c.trust, c.trust_delta);
	return rows;
};

export const formatStateHistory = (h: StateHistoryResponse): string => {
	const changes = [
		...h.transitions.flatMap(stateChanges),
		...h.relationships.flatMap(relationshipChanges),
	].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
	const lines = [
		`期間: ${jst(h.since)} JST から（遷移 ${h.transitions.length} 件、関係 ${h.relationships.length} 件）`,
		"",
		...stateSummary(h),
		...relationshipSummary(h).flatMap((l) => ["", l]),
		"",
		changes.length === 0
			? "(変化なし)"
			: table(
					["TIME (JST)", "TARGET", "ITEM", "CHANGE", "DELTA", "REASON"],
					changes.map((r) => r.cells),
				),
	];
	if (h.truncated) {
		lines.push("", "(件数が上限を超えたため、古い側は含まれていない)");
	}
	return lines.join("\n");
};

const shortModel = (m: string | null) => (m ? m.replace(/^claude-/, "") : "-");

const flags = (a: AuditItem) =>
	[a.fallback_used ? "fallback" : "", a.degraded ? "degraded" : ""]
		.filter(Boolean)
		.join(",") || "-";

const AUDIT_COLUMNS: [title: string, width: number][] = [
	["TIME (JST)", 19],
	["DECISION", 8],
	["REASON", 13],
	["MODEL", 18],
	["TOKENS", 11],
	["MS", 6],
	["FLAGS", 17],
	["INBOUND", 0],
];

const auditLine = (cells: string[]) =>
	cells
		.map((c, i) => pad(c, AUDIT_COLUMNS[i]?.[1] ?? 0))
		.join("  ")
		.trimEnd();

export const auditHeader = (): string =>
	auditLine(AUDIT_COLUMNS.map(([title]) => title));

/** 列幅を固定しているので、-f で行を追記してもヘッダと揃う。 */
export const formatAuditRow = (a: AuditItem): string =>
	auditLine([
		jst(a.created_at),
		a.decision,
		a.reason,
		shortModel(a.model),
		`${a.usage.input_tokens}/${a.usage.output_tokens}`,
		String(a.latency_ms),
		flags(a),
		truncate(a.inbound_content, 40),
	]);

export const formatSnapshots = (items: SnapshotSummary[]): string =>
	items.length === 0
		? "(Snapshot なし)"
		: table(
				["ID", "CREATED (JST)", "SIZE", "SCHEMA", "ENV"],
				items.map((s) => [
					s.id,
					jst(s.created_at),
					String(s.size),
					String(s.schema_version),
					s.env,
				]),
			);
