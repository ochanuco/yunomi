import type {
	AuditItem,
	CandidateView,
	FactView,
	RelationshipView,
	StatusResponse,
} from "@yunomi/admin-contract";
import { h } from "./dom.ts";
import { jst, num, shortModel } from "./format.ts";

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

export const renderStatus = (
	s: StatusResponse,
	rels: RelationshipView[],
): HTMLElement =>
	h(
		"div",
		{},
		h("h2", {}, "State"),
		s.state
			? kv([
					["mood", num(s.state.mood)],
					["energy", num(s.state.energy)],
					["presence", s.state.presence],
					["system stress", num(s.state.system_stress)],
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
							num(r.familiarity),
							num(r.trust),
							jst(r.updated_at),
						]),
					),
				),
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
						num(f.confidence),
						num(f.importance),
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
						num(c.confidence),
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
