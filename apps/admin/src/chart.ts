import { jst, pct } from "./format.ts";
import type { Point, Span } from "./history.ts";

const NS = "http://www.w3.org/2000/svg";

const svg = (
	tag: string,
	attrs: Record<string, string | number> = {},
	...children: (Node | string)[]
): SVGElement => {
	const el = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	for (const c of children) {
		el.append(typeof c === "string" ? document.createTextNode(c) : c);
	}
	return el;
};

export type ChartSeries = { label: string; cls: string; points: Point[] };

export type ChartSpec = {
	title: string;
	from: number;
	to: number;
	yMin: number;
	yMax: number;
	/** この値に基準線を引く。 */
	baseline?: number;
	spans?: Span[];
	series: ChartSeries[];
};

const W = 640;
const H = 180;
const PAD = { l: 40, r: 12, t: 10, b: 22 };

/** 幅は viewBox で可変にする。点の <title> に JST の時刻と値を入れる。 */
export const renderChart = (spec: ChartSpec): HTMLElement => {
	const span = Math.max(spec.to - spec.from, 1);
	const x = (t: number) =>
		PAD.l + ((t - spec.from) / span) * (W - PAD.l - PAD.r);
	const range = spec.yMax - spec.yMin || 1;
	const y = (v: number) =>
		PAD.t + (1 - (v - spec.yMin) / range) * (H - PAD.t - PAD.b);

	const root = svg("svg", {
		viewBox: `0 0 ${W} ${H}`,
		role: "img",
		"aria-label": spec.title,
		class: "chart",
	});

	for (const s of spec.spans ?? []) {
		const x0 = x(Math.max(s.from, spec.from));
		const x1 = x(Math.min(s.to, spec.to));
		root.append(
			svg(
				"rect",
				{
					class: "chart-degraded",
					x: x0,
					y: PAD.t,
					width: Math.max(x1 - x0, 1),
					height: H - PAD.t - PAD.b,
				},
				svg("title", {}, "degraded"),
			),
		);
	}

	const ticks = [spec.yMin, spec.baseline, spec.yMax].filter(
		(v): v is number => v !== undefined,
	);
	for (const v of new Set(ticks)) {
		root.append(
			svg("line", {
				class: v === spec.baseline ? "chart-baseline" : "chart-grid",
				x1: PAD.l,
				x2: W - PAD.r,
				y1: y(v),
				y2: y(v),
			}),
			svg(
				"text",
				{
					class: "chart-label",
					x: PAD.l - 4,
					y: y(v) + 4,
					"text-anchor": "end",
				},
				pct(v),
			),
		);
	}
	root.append(
		svg(
			"text",
			{ class: "chart-label", x: PAD.l, y: H - 6 },
			jst(new Date(spec.from).toISOString()).slice(5, 16),
		),
		svg(
			"text",
			{ class: "chart-label", x: W - PAD.r, y: H - 6, "text-anchor": "end" },
			jst(new Date(spec.to).toISOString()).slice(5, 16),
		),
	);

	for (const s of spec.series) {
		if (s.points.length === 0) continue;
		const d = s.points
			.map(
				(p, i) =>
					`${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`,
			)
			.join("");
		root.append(svg("path", { class: `chart-line ${s.cls}`, d }));
		for (const p of s.points) {
			root.append(
				svg(
					"circle",
					{ class: `chart-dot ${s.cls}`, cx: x(p.t), cy: y(p.v), r: 3 },
					svg(
						"title",
						{},
						`${s.label} ${pct(p.v)} (${jst(new Date(p.t).toISOString())} JST)`,
					),
				),
			);
		}
	}

	const legend = document.createElement("p");
	legend.className = "chart-legend";
	for (const s of spec.series) {
		const key = document.createElement("span");
		key.className = `chart-key ${s.cls}`;
		key.textContent = s.label;
		legend.append(key);
	}
	const figure = document.createElement("figure");
	figure.className = "chart-figure";
	const caption = document.createElement("figcaption");
	caption.textContent = spec.title;
	figure.append(caption, root, legend);
	return figure;
};
