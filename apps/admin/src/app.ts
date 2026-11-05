import { PARTNER_IDS, type PartnerId } from "@yunomi/core";
import { type Api, createApi } from "./api.ts";
import { h } from "./dom.ts";
import { auditPage, memoryPage, type PageHandle, statePage } from "./pages.ts";
import {
	buildHash,
	PAGES,
	type PageName,
	parsePartner,
	parseRoute,
} from "./route.ts";
import { installTooltips } from "./tooltip.ts";

export const POLL_INTERVAL_MS = 10_000;

const PAGE_MODULES = {
	state: statePage,
	memory: memoryPage,
	audit: auditPage,
} as const;

/** ハッシュルーティングで 3 画面を切り替え、表示中の画面だけを定期的に更新する。 */
export const startApp = (
	root: HTMLElement,
	api?: Api,
	intervalMs = POLL_INTERVAL_MS,
	partner: PartnerId = parsePartner(location.search),
): (() => void) => {
	const client = api ?? createApi(undefined, partner);
	const nav = h("nav", { class: "main-nav" });
	const partners = h("nav", { class: "partner-nav" });
	const view = h("main", {});
	const badge = h("span", { class: "env-badge", hidden: true });
	root.replaceChildren(
		h("header", {}, h("h1", {}, "Yunomi Admin"), badge, nav, partners),
		view,
	);
	// dev と prod は同じ画面なので、見ている環境を取り違えないよう dev だけ色を変える。
	void client.status().then(
		({ env }) => {
			const dev = env !== "production";
			badge.textContent = dev ? "DEV" : "PROD";
			badge.hidden = false;
			document.documentElement.dataset.env = dev ? "dev" : "prod";
			if (dev) document.title = `[DEV] ${document.title}`;
		},
		() => {},
	);

	let current: PageHandle | null = null;

	const renderNav = (active: PageName) =>
		nav.replaceChildren(
			...PAGES.map((p) =>
				h(
					"a",
					{
						href: buildHash(p.name),
						"aria-current": p.name === active ? "page" : null,
					},
					p.label,
				),
			),
		);

	// パートナーを切り替えても、見ている画面はそのままにする。
	const renderPartners = () =>
		partners.replaceChildren(
			...PARTNER_IDS.map((id) =>
				h(
					"a",
					{
						href: `?${new URLSearchParams({ partner: id })}${location.hash}`,
						"aria-current": id === partner ? "page" : null,
					},
					id,
				),
			),
		);

	const show = () => {
		current?.dispose();
		const route = parseRoute(location.hash);
		renderNav(route.page);
		renderPartners();
		current = PAGE_MODULES[route.page](view, route, client);
		void current.refresh();
	};

	const tick = () => {
		if (document.visibilityState !== "hidden") void current?.refresh();
	};

	window.addEventListener("hashchange", show);
	const removeTooltips = installTooltips();
	const timer = setInterval(tick, intervalMs);
	show();

	return () => {
		clearInterval(timer);
		window.removeEventListener("hashchange", show);
		removeTooltips();
		current?.dispose();
	};
};
