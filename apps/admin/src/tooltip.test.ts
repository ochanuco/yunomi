import { afterEach, describe, expect, it } from "vitest";
import { h } from "./dom.ts";
import { installTooltips } from "./tooltip.ts";

describe("installTooltips", () => {
	let remove: () => void = () => {};
	afterEach(() => {
		remove();
		document.body.replaceChildren();
	});

	const setup = () => {
		const term = h(
			"span",
			{ class: "term", "data-tip": "機嫌", tabindex: "0" },
			"mood",
		);
		const other = h("span", {}, "x");
		document.body.append(term, other);
		remove = installTooltips();
		const tip = document.querySelector<HTMLElement>(".tooltip");
		if (!tip) throw new Error("tooltip がない");
		return { term, other, tip };
	};

	it("ホバーで説明を出し、ほかの要素に移ると消す", () => {
		const { term, other, tip } = setup();
		term.dispatchEvent(new Event("pointerover", { bubbles: true }));
		expect(tip.hidden).toBe(false);
		expect(tip.textContent).toBe("機嫌");
		other.dispatchEvent(new Event("pointerover", { bubbles: true }));
		expect(tip.hidden).toBe(true);
	});

	it("描き直しで置き換わった要素にも出る", () => {
		const { term, tip } = setup();
		const fresh = h("span", { class: "term", "data-tip": "元気" }, "energy");
		term.replaceWith(fresh);
		fresh.dispatchEvent(new Event("pointerover", { bubbles: true }));
		expect(tip.textContent).toBe("元気");
	});

	it("フォーカスで出し、Escape で消す", () => {
		const { term, tip } = setup();
		term.focus();
		expect(tip.hidden).toBe(false);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(tip.hidden).toBe(true);
	});
});
