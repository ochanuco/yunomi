/**
 * 忘却曲線の係数。RC06 の eval で調整するので、ここ以外に置かない。
 * S は日数で、R = exp(−t / S)。
 */
export const FORGETTING = {
	/** 何も伸ばす要素が無いときの S。続く事実は出来事より長く残る。 */
	baseStabilityDays: {
		lasting: 60,
		episode: 14,
		work_note: 21,
		conversation: 14,
	},
	/** importance（0〜1）の分だけ S を 1 + 重み × importance 倍にする。 */
	importanceWeight: 3,
	/** importance を持たない記憶（work_notes、会話の塊）に使う値。 */
	defaultImportance: 0.5,
	/** 想起のたびに S に掛ける倍率。間隔反復と同じく、思い出すほど次は忘れにくくなる。 */
	recallGrowth: 1.8,
	/** 持ち主が同じ話を再び出すたびに S に掛ける倍率。 */
	restateGrowth: 2,
	/** 回数が重なっても S が際限なく伸びないようにする上限。 */
	maxStabilityDays: 3650,
	/** これを下回る R の記憶は、日付を粗くし細部を落として渡す。 */
	vagueBelow: 0.3,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** facts.decay_policy。lasting は standard、episode は episodic に残す。 */
export const DECAY_POLICY = {
	lasting: "standard",
	episode: "episodic",
} as const;

/** episodic 以外の値は standard として扱う。 */
export const factRetentionKind = (
	decayPolicy: string,
): "lasting" | "episode" =>
	decayPolicy === DECAY_POLICY.episode ? "episode" : "lasting";

export type RetentionKind = keyof typeof FORGETTING.baseStabilityDays;

export type RetentionInput = {
	kind: RetentionKind;
	importance: number | null;
	recallCount: number;
	restateCount: number;
	/** 最後に触れた時刻。`lastTouched` で求める。 */
	touchedAt: Date;
};

/** 覚えた・言い直された時刻と、最後に想起した時刻のうち新しいほう。 */
export const lastTouched = (seenAt: string, lastRecalledAt: string | null) =>
	new Date(Math.max(Date.parse(seenAt), Date.parse(lastRecalledAt ?? "") || 0));

export const stabilityDays = (i: RetentionInput): number => {
	const f = FORGETTING;
	const importance = i.importance ?? f.defaultImportance;
	const s =
		f.baseStabilityDays[i.kind] *
		(1 + f.importanceWeight * importance) *
		f.recallGrowth ** i.recallCount *
		f.restateGrowth ** i.restateCount;
	return Math.min(s, f.maxStabilityDays);
};

/** 保持率 R（0〜1）。未来の時刻（時計のずれ）は t = 0 にする。 */
export const retention = (i: RetentionInput, now: Date): number => {
	const days = Math.max(0, (now.getTime() - i.touchedAt.getTime()) / DAY_MS);
	return Math.exp(-days / stabilityDays(i));
};

export const isVague = (r: number): boolean => r < FORGETTING.vagueBelow;
