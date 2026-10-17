import * as v from "valibot";
import type { ToolDefinition } from "../contract.ts";

const placeSearchInput = v.object({
	query: v.pipe(
		v.string(),
		v.trim(),
		v.minLength(1),
		v.maxLength(100),
		v.description(
			"検索語。店名や場所の名前に、地名を添える（例 くずは 麦とラーメン）",
		),
	),
});

export type PlaceSearchInput = v.InferOutput<typeof placeSearchInput>;

export const placeSearch: ToolDefinition<PlaceSearchInput> = {
	name: "place_search",
	description:
		"Google マップで店や場所を検索し、候補を最大 3 件まで返す。名前、住所、営業状態、いま営業中か、今日の営業時間が分かる。混雑状況は分からない。データは古いことがある。",
	category: "place_read",
	input: placeSearchInput,
};
