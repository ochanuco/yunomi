export type Child = Node | string | number | null | undefined | false;

type Attr = string | boolean | ((e: Event) => void) | null | undefined;

/**
 * 文字列は必ず text node にする。innerHTML は使わないので、API 由来の値
 * （受信本文など）に HTML が含まれても要素として解釈されない。
 */
export const h = <K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, Attr> = {},
	...children: Child[]
): HTMLElementTagNameMap[K] => {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === null || value === undefined || value === false) continue;
		if (typeof value === "function") {
			el.addEventListener(key.replace(/^on/, ""), value);
		} else {
			el.setAttribute(key, value === true ? "" : value);
		}
	}
	append(el, children);
	return el;
};

export const append = (parent: Node, children: Child[]): void => {
	for (const c of children) {
		if (c === null || c === undefined || c === false) continue;
		parent.appendChild(
			typeof c === "string" || typeof c === "number"
				? document.createTextNode(String(c))
				: c,
		);
	}
};
