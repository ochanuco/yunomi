import { DEFAULT_PARTNER_ID, isPartnerId, type PartnerId } from "@yunomi/core";

export type PageName = "state" | "memory" | "audit";

export type Route = { page: PageName; params: URLSearchParams };

export const PAGES: { name: PageName; label: string }[] = [
	{ name: "state", label: "State" },
	{ name: "memory", label: "Memory" },
	{ name: "audit", label: "Audit" },
];

const isPage = (s: string): s is PageName => PAGES.some((p) => p.name === s);

/** `#/audit?id=...` を解釈する。未知のパスは State に倒す。 */
export const parseRoute = (hash: string): Route => {
	const body = hash.replace(/^#\/?/, "");
	const [path = "", query = ""] = body.split("?", 2);
	return {
		page: isPage(path) ? path : "state",
		params: new URLSearchParams(query),
	};
};

export const buildHash = (
	page: PageName,
	params: Record<string, string> = {},
): string => {
	const q = new URLSearchParams(params).toString();
	return `#/${page}${q ? `?${q}` : ""}`;
};

/**
 * 見るパートナーは `?partner=` で選ぶ。ハッシュの外に置くので、画面内のリンクが持ち回らなくてよい。
 * 名簿にない値や指定なしは既定のパートナー。
 */
export const parsePartner = (search: string): PartnerId => {
	const id = new URLSearchParams(search).get("partner") ?? "";
	return isPartnerId(id) ? id : DEFAULT_PARTNER_ID;
};
