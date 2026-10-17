import type {
	AuditItem,
	CandidateView,
	FactView,
	MemoryKind,
} from "@yunomi/admin-contract";
import { type Api, ApiError } from "./api.ts";
import { append, h } from "./dom.ts";
import { jstTime } from "./format.ts";
import { parseDays } from "./history.ts";
import { mergeNewest } from "./paging.ts";
import { buildHash, type Route } from "./route.ts";
import {
	renderAuditDrawer,
	renderAuditList,
	renderCandidates,
	renderError,
	renderFacts,
	renderStatus,
} from "./views.ts";

export const PAGE_SIZE = 50;

export type PageHandle = {
	/** 先頭から取り直して描き直す。ポーリングと初回表示で呼ぶ。 */
	refresh(): Promise<void>;
	dispose(): void;
};

export type Page = (
	root: HTMLElement,
	route: Route,
	api: Api,
	now?: () => Date,
) => PageHandle;

const message = (e: unknown) =>
	e instanceof ApiError ? e.message : "読み込みに失敗した";

/** 失敗しても直前の表示は残し、状態行にエラーを出す。 */
const frame = (root: HTMLElement) => {
	const status = h("p", { class: "status-line" });
	const body = h("div", { class: "page-body" });
	root.replaceChildren(status, body);
	return {
		body,
		ok: () => {
			status.textContent = `最終更新 ${jstTime(new Date())} JST`;
			status.classList.remove("failed");
		},
		fail: (e: unknown) => {
			status.replaceChildren(renderError(message(e)));
			status.classList.add("failed");
		},
	};
};

export const statePage: Page = (root, route, api, now = () => new Date()) => {
	// 期間は hash のクエリに持つ。切り替えは hashchange でページごと作り直すので、ポーリングでは消えない。
	const days = parseDays(route.params.get("days"));
	const f = frame(root);
	return {
		async refresh() {
			try {
				const [status, rels, history] = await Promise.all([
					api.status(),
					api.relationships(),
					api.stateHistory(days),
				]);
				f.body.replaceChildren(
					renderStatus(status, rels.items, { days, data: history, now: now() }),
				);
				f.ok();
			} catch (e) {
				f.fail(e);
			}
		},
		dispose() {},
	};
};

export const memoryPage: Page = (root, route, api, now = () => new Date()) => {
	const kind: MemoryKind =
		route.params.get("kind") === "candidates" ? "candidates" : "facts";
	const f = frame(root);
	const tabs = h(
		"nav",
		{ class: "tabs" },
		...(["facts", "candidates"] as const).map((k) =>
			h(
				"a",
				{
					href: buildHash("memory", { kind: k }),
					"aria-current": k === kind ? "page" : null,
				},
				k === "facts" ? "Facts" : "Candidates",
			),
		),
	);
	let facts: FactView[] = [];
	let candidates: CandidateView[] = [];
	let cursor: string | null = null;
	let olderLoaded = false;

	const draw = () => {
		const more =
			cursor === null
				? null
				: h(
						"button",
						{ type: "button", onclick: () => void loadOlder() },
						"古いものを読み込む",
					);
		f.body.replaceChildren();
		append(f.body, [
			tabs,
			kind === "facts"
				? renderFacts(facts, now())
				: renderCandidates(candidates),
			more,
		]);
	};

	const loadOlder = async () => {
		if (cursor === null) return;
		try {
			const page = await api.memory({ kind, limit: PAGE_SIZE, cursor });
			olderLoaded = true;
			cursor = page.next_cursor;
			if (page.kind === "facts") {
				facts = mergeNewest(facts, page.items, (x) => x.observed_at);
			} else {
				candidates = mergeNewest(candidates, page.items, (x) => x.created_at);
			}
			draw();
			f.ok();
		} catch (e) {
			f.fail(e);
		}
	};

	return {
		async refresh() {
			try {
				const page = await api.memory({ kind, limit: PAGE_SIZE });
				if (page.kind === "facts") {
					facts = mergeNewest(facts, page.items, (x) => x.observed_at);
				} else {
					candidates = mergeNewest(candidates, page.items, (x) => x.created_at);
				}
				if (!olderLoaded) cursor = page.next_cursor;
				draw();
				f.ok();
			} catch (e) {
				f.fail(e);
			}
		},
		dispose() {},
	};
};

export const auditPage: Page = (root, route, api) => {
	const f = frame(root);
	let items: AuditItem[] = [];
	let cursor: string | null = null;
	let olderLoaded = false;
	let selectedId = route.params.get("id");

	const select = (id: string | null) => {
		selectedId = id;
		// hashchange を起こさず URL だけ更新する（一覧を作り直さないため）。
		history.replaceState(
			null,
			"",
			id ? buildHash("audit", { id }) : buildHash("audit"),
		);
		draw();
	};

	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape" && selectedId) select(null);
	};
	document.addEventListener("keydown", onKey);

	const draw = () => {
		const selected = items.find((a) => a.id === selectedId);
		const layout = h("div", { class: "split" });
		append(layout, [
			h(
				"div",
				{ class: "list" },
				renderAuditList(items, selectedId, (id) => select(id)),
				cursor === null
					? null
					: h(
							"button",
							{ type: "button", onclick: () => void loadOlder() },
							"古いものを読み込む",
						),
			),
			selected ? renderAuditDrawer(selected, () => select(null)) : null,
		]);
		f.body.replaceChildren(layout);
	};

	const loadOlder = async () => {
		if (cursor === null) return;
		try {
			const page = await api.audit({ limit: PAGE_SIZE, cursor });
			olderLoaded = true;
			cursor = page.next_cursor;
			items = mergeNewest(items, page.items, (a) => a.created_at);
			draw();
			f.ok();
		} catch (e) {
			f.fail(e);
		}
	};

	return {
		async refresh() {
			try {
				const page = await api.audit({ limit: PAGE_SIZE });
				items = mergeNewest(items, page.items, (a) => a.created_at);
				if (!olderLoaded) cursor = page.next_cursor;
				draw();
				f.ok();
			} catch (e) {
				f.fail(e);
			}
		},
		dispose() {
			document.removeEventListener("keydown", onKey);
		},
	};
};
