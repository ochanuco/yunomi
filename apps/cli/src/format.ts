import type {
	AuditItem,
	CandidateView,
	FactView,
	InterestView,
	KpiDay,
	OpenLoopView,
	OpinionView,
	RelationshipView,
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
