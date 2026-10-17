import type {
	AuditItem,
	CandidateView,
	FactView,
	RelationshipView,
	StateHistoryResponse,
	StatusResponse,
} from "@yunomi/admin-contract";
import { renderChart } from "./chart.ts";
import { h } from "./dom.ts";
import { jst, pct, shortModel, signedPct } from "./format.ts";
import {
	changeRows,
	degradedSpans,
	HISTORY_DAYS,
	relationshipSeries,
	stateSeries,
} from "./history.ts";
import { buildHash } from "./route.ts";

export const renderError = (message: string): HTMLElement =>
	h("p", { class: "error", role: "alert" }, message);

const empty = (text: string) => h("p", { class: "empty" }, text);

const table = (
	header: string[],
	rows: HTMLElement[],
	className = "",
): HTMLElement =>
	h(
		"div",
		{ class: "table-wrap" },
		h(
			"table",
			{ class: className },
			h("thead", {}, h("tr", {}, ...header.map((t) => h("th", {}, t)))),
			h("tbody", {}, ...rows),
		),
	);

const tr = (cells: (string | HTMLElement)[], attrs = {}) =>
	h("tr", attrs, ...cells.map((c) => h("td", {}, c)));

const kv = (pairs: [string, string][]): HTMLElement =>
	h(
		"dl",
		{ class: "kv" },
		...pairs.flatMap(([k, val]) => [h("dt", {}, k), h("dd", {}, val)]),
	);

export type HistoryView = {
	days: number;
	data: StateHistoryResponse;
	now: Date;
};

const CHANGE_ROWS = 50;

const renderHistory = ({ days, data, now }: HistoryView): HTMLElement => {
	const until = now.getTime();
	const from = Date.parse(data.since);
	const base = { from, to: until };
	const rels = relationshipSeries(data, until);
	const rows = changeRows(data, CHANGE_ROWS);
	const hasState = data.transitions.length > 0 || data.state_at_start !== null;
	return h(
		"section",
		{ class: "history" },
		h("h2", {}, "推移"),
		h(
			"nav",
			{ class: "range" },
			...HISTORY_DAYS.map((d) =>
				h(
					"a",
					{
						href: buildHash("state", { days: String(d) }),
						"aria-current": d === days ? "page" : null,
					},
					d === 1 ? "24h" : `${d}d`,
				),
			),
		),
		data.truncated
			? h(
					"p",
					{ class: "note" },
					"件数が上限を超えたため、古い変化は省いている（新しい側だけ表示）",
				)
			: null,
		hasState
			? h(
					"div",
					{},
					renderChart({
						...base,
						title: "mood / energy",
						yMin: -1,
						yMax: 1,
						baseline: 0,
						spans: degradedSpans(data, until),
						series: [
							{
								label: "mood",
								cls: "s-mood",
								points: stateSeries(data, "mood", until),
							},
							{
								label: "energy",
								cls: "s-energy",
								points: stateSeries(data, "energy", until),
							},
						],
					}),
					renderChart({
						...base,
						title: "system stress",
						yMin: 0,
						yMax: 1,
						spans: degradedSpans(data, until),
						series: [
							{
								label: "system_stress",
								cls: "s-stress",
								points: stateSeries(data, "system_stress", until),
							},
						],
					}),
				)
			: empty("この期間に State の変化がない"),
		...rels.map((r) => {
			const all = [...r.familiarity, ...r.trust].map((p) => p.v);
			return renderChart({
				...base,
				title: `${r.name}: familiarity / trust`,
				yMin: Math.min(0, ...all),
				yMax: Math.max(1, ...all),
				series: [
					{ label: "familiarity", cls: "s-familiarity", points: r.familiarity },
					{ label: "trust", cls: "s-trust", points: r.trust },
				],
			});
		}),
		h("h3", {}, "直近の変化"),
		rows.length === 0
			? empty("この期間に変化がない")
			: table(
					["時刻 (JST)", "対象", "項目", "前 → 後", "差分", "reason"],
					rows.map((r) =>
						tr([
							jst(r.at),
							r.target,
							r.item,
							`${r.before} → ${r.after}`,
							r.diff === null
								? ""
								: h(
										"span",
										{ class: r.diff > 0 ? "delta-pos" : "delta-neg" },
										signedPct(r.diff),
									),
							r.reason,
						]),
					),
				),
	);
};

export const renderStatus = (
	s: StatusResponse,
	rels: RelationshipView[],
	history?: HistoryView,
): HTMLElement =>
	h(
		"div",
		{},
		h("h2", {}, "State"),
		s.state
			? kv([
					["mood", pct(s.state.mood)],
					["energy", pct(s.state.energy)],
					["presence", s.state.presence],
					["system stress", pct(s.state.system_stress)],
					["degraded", s.state.degraded_mode ? "yes" : "no"],
					["version", String(s.state.version)],
					["更新 (JST)", jst(s.state.updated_at)],
				])
			: empty("まだ State がない（最初のターンを処理すると作られる）"),
		h("h2", {}, "Partner"),
		kv([
			["partner", s.partner_id],
			["env", s.env],
			["profile version", String(s.profile_version)],
			["facts", String(s.counts.facts)],
			["pending candidates", String(s.counts.pending_candidates)],
			["最後の audit (JST)", jst(s.last_audit_at)],
		]),
		h("h2", {}, "Relationships"),
		rels.length === 0
			? empty("まだ関係がない")
			: table(
					["相手", "親しさ", "信頼", "更新 (JST)"],
					rels.map((r) =>
						tr([
							r.display_name ?? r.entity_id,
							pct(r.familiarity),
							pct(r.trust),
							jst(r.updated_at),
						]),
					),
				),
		history ? renderHistory(history) : null,
	);

const factState = (f: FactView, now: Date) => {
	if (f.superseded_by) return "superseded";
	if (f.valid_to && Date.parse(f.valid_to) <= now.getTime()) return "expired";
	return "current";
};

export const renderFacts = (items: FactView[], now: Date): HTMLElement =>
	items.length === 0
		? empty("Fact はまだない")
		: table(
				["観測 (JST)", "状態", "predicate", "値", "確信度", "重要度", "source"],
				items.map((f) =>
					tr([
						jst(f.observed_at),
						factState(f, now),
						f.predicate,
						f.object_display ?? f.object_value,
						pct(f.confidence),
						pct(f.importance),
						f.source,
					]),
				),
			);

export const renderCandidates = (items: CandidateView[]): HTMLElement =>
	items.length === 0
		? empty("candidate はまだない")
		: table(
				[
					"作成 (JST)",
					"status",
					"subject",
					"predicate",
					"値",
					"確信度",
					"source",
				],
				items.map((c) =>
					tr([
						jst(c.created_at),
						c.status,
						c.subject_text ?? "(話者)",
						c.predicate,
						c.object_value,
						pct(c.confidence),
						c.source,
					]),
				),
			);

export const renderAuditList = (
	items: AuditItem[],
	selectedId: string | null,
	onSelect: (id: string) => void,
): HTMLElement =>
	items.length === 0
		? empty("audit はまだない")
		: table(
				["時刻 (JST)", "判断", "理由", "モデル", "token", "ms", "本文"],
				items.map((a) => {
					const row = tr(
						[
							jst(a.created_at),
							a.decision,
							a.reason +
								(a.fallback_used ? " / fallback" : "") +
								(a.degraded ? " / degraded" : ""),
							shortModel(a.model),
							`${a.usage.input_tokens}/${a.usage.output_tokens}`,
							String(a.latency_ms),
							a.inbound_content,
						],
						{
							class: `clickable${a.id === selectedId ? " selected" : ""}`,
							tabindex: "0",
							"data-id": a.id,
							onclick: () => onSelect(a.id),
							onkeydown: (e: Event) => {
								const key = (e as KeyboardEvent).key;
								if (key === "Enter" || key === " ") {
									e.preventDefault();
									onSelect(a.id);
								}
							},
						},
					);
					return row;
				}),
				"audit",
			);

export const renderAuditDrawer = (
	a: AuditItem,
	onClose: () => void,
): HTMLElement =>
	h(
		"aside",
		{ class: "drawer", "aria-label": "audit 詳細" },
		h(
			"div",
			{ class: "drawer-head" },
			h("h2", {}, "Audit 詳細"),
			h("button", { type: "button", onclick: onClose }, "閉じる"),
		),
		kv([
			["時刻 (JST)", jst(a.created_at)],
			["判断", `${a.decision} (${a.reason})`],
			["判断サマリ", a.decision_summary ?? "-"],
			["モデル", a.model ?? "-"],
			["fallback", a.fallback_used ? "yes" : "no"],
			["degraded", a.degraded ? "yes" : "no"],
			["エラー", a.error_type ?? "-"],
			[
				"token",
				`in ${a.usage.input_tokens} / out ${a.usage.output_tokens} / cache read ${a.usage.cache_read_tokens} / cache write ${a.usage.cache_write_tokens}`,
			],
			["latency", `${a.latency_ms} ms`],
			["channel", a.channel_id],
			["author entity", a.author_entity_id ?? "-"],
			["event id", a.event_id],
		]),
		h("h3", {}, "受信本文"),
		h("pre", {}, a.inbound_content),
		h("h3", {}, "detail"),
		h("pre", {}, JSON.stringify(a.detail, null, 2)),
	);
