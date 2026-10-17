import { prng } from "./select-examples.ts";

// temperature は既定の上限 1.0 のままでも、同じ場面ではモデルが毎回同じ書き出しを選ぶ。
// 入り方をターンごとに変えて、書き出しを散らす。どの場面に当てても丁寧さと人格を崩さないものだけを置く。
export const OPENINGS: readonly string[] = [
	"結論を一言で言うところから入る",
	"短い感想の一言から入る",
	"相手の様子や気持ちに触れるところから入る",
	"自分ならどうするかを言うところから入る",
	"気になった一点を取り上げるところから入る",
	"事実や前提を一つ確かめるところから入る",
	"この先どうなりそうかを言うところから入る",
];

/** 書き出しの入り方を 1 つ選ぶ。同じ seed なら同じ結果になる。 */
export const selectOpening = (seed: string): string =>
	OPENINGS[Math.floor(prng(`${seed}:opening`)() * OPENINGS.length)] as string;
