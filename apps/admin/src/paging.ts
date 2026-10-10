/** ポーリングで取り直した先頭ページを、すでに読み込んだ一覧へ重複なく混ぜる。新しい順。 */
export const mergeNewest = <T extends { id: string }>(
	existing: T[],
	fresh: T[],
	sortKey: (item: T) => string,
): T[] => {
	const byId = new Map<string, T>();
	for (const item of existing) byId.set(item.id, item);
	for (const item of fresh) byId.set(item.id, item);
	return [...byId.values()].sort((a, b) => {
		const ka = sortKey(a);
		const kb = sortKey(b);
		if (ka !== kb) return ka < kb ? 1 : -1;
		return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
	});
};
