import { h } from "./dom.ts";

const GAP = 6;
const MARGIN = 8;

/**
 * `.term[data-tip]` の説明を、ホバー・フォーカス・タップで出す。
 * ブラウザ標準の title は出るまでに間があり、タッチ端末では出ないので自前で出す。
 * 画面は定期的に描き直されるため、要素ごとではなく document に委譲する。
 */
export const installTooltips = (doc: Document = document): (() => void) => {
	const tip = h("div", { class: "tooltip", role: "tooltip", hidden: true });
	doc.body.append(tip);
	let anchor: Element | null = null;

	const show = (el: Element) => {
		const text = el.getAttribute("data-tip");
		if (!text) return;
		anchor = el;
		tip.textContent = text;
		tip.hidden = false;
		const view = doc.defaultView;
		const r = el.getBoundingClientRect();
		const width = tip.offsetWidth;
		const maxLeft = (view?.innerWidth ?? width) - width - MARGIN;
		tip.style.left = `${Math.max(MARGIN, Math.min(r.left, maxLeft))}px`;
		const below = r.bottom + GAP;
		const fitsBelow =
			below + tip.offsetHeight <=
			(view?.innerHeight ?? Number.POSITIVE_INFINITY);
		tip.style.top = `${fitsBelow ? below : r.top - GAP - tip.offsetHeight}px`;
	};
	const hide = () => {
		anchor = null;
		tip.hidden = true;
	};
	const termOf = (e: Event): Element | null =>
		e.target instanceof Element ? e.target.closest(".term[data-tip]") : null;

	const onOver = (e: Event) => {
		const el = termOf(e);
		if (el) show(el);
		else if (anchor) hide();
	};
	const onFocus = (e: Event) => {
		const el = termOf(e);
		if (el) show(el);
	};
	const onKey = (e: Event) => {
		if ((e as KeyboardEvent).key === "Escape") hide();
	};

	doc.addEventListener("pointerover", onOver);
	doc.addEventListener("focusin", onFocus);
	doc.addEventListener("focusout", hide);
	doc.addEventListener("scroll", hide, true);
	doc.addEventListener("keydown", onKey);
	return () => {
		doc.removeEventListener("pointerover", onOver);
		doc.removeEventListener("focusin", onFocus);
		doc.removeEventListener("focusout", hide);
		doc.removeEventListener("scroll", hide, true);
		doc.removeEventListener("keydown", onKey);
		tip.remove();
	};
};
