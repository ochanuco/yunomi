import { describe, expect, it } from "vitest";
import { h } from "./dom.ts";

describe("h", () => {
	it("文字列の子は HTML として解釈しない", () => {
		const el = h("p", {}, '<img src=x onerror="alert(1)">');
		expect(el.querySelector("img")).toBeNull();
		expect(el.textContent).toBe('<img src=x onerror="alert(1)">');
	});

	it("属性値も文字列のまま入る", () => {
		const el = h("a", { href: '"><script>x</script>' }, "link");
		expect(el.querySelector("script")).toBeNull();
		expect(el.getAttribute("href")).toBe('"><script>x</script>');
	});

	it("false / null の子と属性は無視し、on* はイベントとして登録する", () => {
		let clicked = 0;
		const el = h(
			"button",
			{ onclick: () => clicked++, disabled: false, title: null },
			"x",
			null,
			false,
		);
		el.click();
		expect(clicked).toBe(1);
		expect(el.hasAttribute("disabled")).toBe(false);
		expect(el.childNodes).toHaveLength(1);
	});
});
