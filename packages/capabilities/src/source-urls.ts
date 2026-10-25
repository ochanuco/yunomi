// 日本語の地の文に続けて書かれた URL を、後ろの文まで含めて拾わないよう、ASCII の URL 文字だけを取る。
const URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g;
// 文末の句読点や閉じ括弧が URL の一部かどうかは文字だけでは決まらないので、両方の形を候補に入れる。
const TRAILING_PUNCTUATION = /[.,;:!?'()[\]]+$/;

// fragment はサーバーに送られないので比べない。それ以外は一致を求め、クエリやパスにデータを足させない。
const normalize = (value: string): string | null => {
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		return url.href;
	} catch {
		return null;
	}
};

/** テキストに現れた http(s) の URL を正規化して返す。 */
export const extractUrls = (text: string): string[] => {
	const found = new Set<string>();
	for (const [match] of text.matchAll(URL_PATTERN)) {
		for (const candidate of [match, match.replace(TRAILING_PUNCTUATION, "")]) {
			const normalized = normalize(candidate);
			if (normalized !== null) found.add(normalized);
		}
	}
	return [...found];
};

/** url が sources のどれかと（fragment を除いて）一致するか。sources は `extractUrls` の結果。 */
export const isUrlFromSource = (
	url: string,
	sources: readonly string[],
): boolean => {
	const normalized = normalize(url);
	return normalized !== null && sources.includes(normalized);
};
