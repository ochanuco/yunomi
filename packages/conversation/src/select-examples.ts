import type { ConversationExample } from "@yunomi/core";

/** 1 ターンのプロンプトに入れる会話例の件数。 */
export const EXAMPLE_COUNT = 4;

/** 文字列を 32bit のシードにする（FNV-1a）。 */
const hashSeed = (seed: string): number => {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
};

/** mulberry32。同じシードなら同じ列を返す。 */
export const prng = (seed: string): (() => number) => {
	let a = hashSeed(seed);
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

/** 今の親しさに足りない会話例は候補から外す。min_familiarity がない例は常に使える。 */
export const eligibleExamples = (
	examples: readonly ConversationExample[],
	familiarity: number,
): ConversationExample[] =>
	examples.filter((e) => (e.min_familiarity ?? 0) <= familiarity);

/**
 * 会話例を場面の重ならないように count 件選ぶ。場面を無作為に選び、場面の中から 1 件選ぶ。
 * 親しさが足りない例は除く。同じ seed なら同じ結果になる。場面が count 未満なら場面ごとに 1 件。
 */
export const selectExamples = (
	examples: readonly ConversationExample[],
	opts: { seed: string; count: number; familiarity: number },
): ConversationExample[] => {
	const byScene = new Map<string, ConversationExample[]>();
	for (const e of eligibleExamples(examples, opts.familiarity)) {
		const list = byScene.get(e.scene);
		if (list) list.push(e);
		else byScene.set(e.scene, [e]);
	}
	const rand = prng(opts.seed);
	const scenes = [...byScene.keys()];
	const picked: ConversationExample[] = [];
	while (scenes.length > 0 && picked.length < opts.count) {
		const [scene] = scenes.splice(Math.floor(rand() * scenes.length), 1);
		const list = byScene.get(scene as string) ?? [];
		const one = list[Math.floor(rand() * list.length)];
		if (one) picked.push(one);
	}
	return picked;
};
