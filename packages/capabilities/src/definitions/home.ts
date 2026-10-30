import * as v from "valibot";
import type { ToolDefinition } from "../contract.ts";

// 読む entity は設定で固定するので、モデルからは何も受け取らない。
const homeStateInput = v.object({});

export type HomeStateInput = v.InferOutput<typeof homeStateInput>;

export const homeState: ToolDefinition<HomeStateInput> = {
	name: "home_state",
	description:
		"家の Home Assistant から、あらかじめ決められた entity の今の状態を読む。在宅かどうか（person の state が home / not_home）、スマホの電池、天気（weather は気温と湿度つき）、いる場所（住所は町名まで）、家からの距離と向き（direction_of_travel が towards なら家に向かっている、away_from なら離れている、arrived なら家にいる）などが分かる。state は Home Assistant の表記のまま返り（時刻の state は日時で返る）、last_changed はその state になった日時。決められた entity 以外は読めない。",
	category: "home_read",
	input: homeStateInput,
};
