import type { PartnerProfile } from "./partner-profile.ts";

/** Interest 1 シグナルあたりの score の変化量。LLM は向きだけを返し、大きさはここで決める。 */
export const INTEREST_SIGNAL_STEP = 0.03;
/** 同じ topic が 1 生活日に動ける score の純変化量の上限（上下とも）。 */
export const INTEREST_DAILY_CAP = 0.1;
/** baseline からの乖離（learned_delta）の上限（上下とも）。 */
export const INTEREST_LEARNED_DELTA_CAP = 0.3;
/** 1 ターンで受け付ける interest_signals の件数。 */
export const INTEREST_MAX_SIGNALS_PER_TURN = 2;
/** prompt に入れる Interest の件数。 */
export const INTEREST_PROMPT_LIMIT = 8;

/** Opinion の strengthen / weaken / shift 1 回あたりの confidence の変化量の基準。実際は (1 - stability) を掛ける。 */
export const OPINION_CONFIDENCE_STEP = 0.05;
/** shift で confidence がこの値を下回り、かつ new_stance があるとき stance を置き換える。 */
export const OPINION_SHIFT_THRESHOLD = 0.25;
/** stance を置き換えた直後の confidence。 */
export const OPINION_SHIFT_RESET_CONFIDENCE = 0.4;
/** 1 ターンで受け付ける opinion_signals の件数。 */
export const OPINION_MAX_SIGNALS_PER_TURN = 1;
/** 同じ topic が 1 生活日に変われる回数。 */
export const OPINION_MAX_CHANGES_PER_DAY = 1;
/** 保持する reasons の件数。古いものから捨てる。 */
export const OPINION_REASONS_MAX = 5;
export const OPINION_STANCE_MAX_LENGTH = 200;
export const OPINION_PROMPT_LIMIT = 5;

export type InterestSource = "profile" | "learned";

export type InterestState = {
	topic: string;
	label: string;
	score: number;
	baseline: number;
	learnedDelta: number;
	summary: string;
	updatedAt: string | null;
	source: InterestSource;
};

export type OpinionState = {
	topic: string;
	label: string;
	stance: string;
	confidence: number;
	stability: number;
	reasons: string[];
	sourceMemoryIds: string[];
	updatedAt: string | null;
	source: InterestSource;
};

/** 保存済みの行（label を持たない）。無い topic はプロファイルの初期値で補う。 */
export type StoredInterest = Pick<
	InterestState,
	"topic" | "score" | "baseline" | "learnedDelta" | "summary" | "updatedAt"
>;
export type StoredOpinion = Pick<
	OpinionState,
	| "topic"
	| "stance"
	| "confidence"
	| "stability"
	| "reasons"
	| "sourceMemoryIds"
	| "updatedAt"
>;

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const clamp = (n: number, min: number, max: number) =>
	Math.min(max, Math.max(min, n));

/** プロファイルの順に、保存済みの行があればそれを、なければ初期値を返す。 */
export const resolveInterests = (
	profile: PartnerProfile,
	stored: StoredInterest[],
): InterestState[] => {
	const byTopic = new Map(stored.map((r) => [r.topic, r]));
	return profile.interests.map((i) => {
		const row = byTopic.get(i.topic);
		return row
			? { ...row, label: i.label, source: "learned" as const }
			: {
					topic: i.topic,
					label: i.label,
					score: i.baseline,
					baseline: i.baseline,
					learnedDelta: 0,
					summary: i.summary,
					updatedAt: null,
					source: "profile" as const,
				};
	});
};

export const resolveOpinions = (
	profile: PartnerProfile,
	stored: StoredOpinion[],
): OpinionState[] => {
	const byTopic = new Map(stored.map((r) => [r.topic, r]));
	return profile.opinions.map((o) => {
		const row = byTopic.get(o.topic);
		return row
			? { ...row, label: o.label, source: "learned" as const }
			: {
					topic: o.topic,
					label: o.label,
					stance: o.stance,
					confidence: o.confidence,
					stability: o.stability,
					reasons: [],
					sourceMemoryIds: [],
					updatedAt: null,
					source: "profile" as const,
				};
	});
};

export type InterestSignal = {
	topic: string;
	direction: "up" | "down";
	reason: string;
};

export type OpinionSignal = {
	topic: string;
	direction: "strengthen" | "weaken" | "shift";
	newStance: string | null;
	reason: string;
};

export type SignalRejection =
	| "unknown_topic"
	| "limit"
	| "daily_cap"
	| "learned_cap"
	| "no_change";

export type RejectedSignal = { topic: string; reason: SignalRejection };

export type InterestChange = {
	topic: string;
	before: InterestState;
	after: InterestState;
	reason: string;
};

export type InterestUpdate = {
	changes: InterestChange[];
	rejected: RejectedSignal[];
};

/**
 * Interest の向きを、定数で決めた大きさに直して適用する。
 * dailyNet は topic ごとの、この生活日の score の純変化量（既に保存した分）。
 * 上限に届いた分は切り詰め、1 ミリも動けないシグナルだけを rejected にする。
 */
export const applyInterestSignals = (
	current: InterestState[],
	signals: InterestSignal[],
	dailyNet: Record<string, number>,
	now: Date,
): InterestUpdate => {
	const state = new Map(current.map((s) => [s.topic, s]));
	const net = { ...dailyNet };
	const firstBefore = new Map<string, InterestState>();
	const reasons = new Map<string, string>();
	const rejected: RejectedSignal[] = [];

	let known = 0;
	for (const sig of signals) {
		const s = state.get(sig.topic);
		if (!s) {
			rejected.push({ topic: sig.topic, reason: "unknown_topic" });
			continue;
		}
		if (known++ >= INTEREST_MAX_SIGNALS_PER_TURN) {
			rejected.push({ topic: sig.topic, reason: "limit" });
			continue;
		}
		const sign = sig.direction === "up" ? 1 : -1;
		const dayNet = round(net[sig.topic] ?? 0);
		const dailyRoom =
			sign > 0 ? INTEREST_DAILY_CAP - dayNet : INTEREST_DAILY_CAP + dayNet;
		if (dailyRoom <= 0) {
			rejected.push({ topic: sig.topic, reason: "daily_cap" });
			continue;
		}
		const learnedRoom =
			sign > 0
				? Math.min(INTEREST_LEARNED_DELTA_CAP - s.learnedDelta, 1 - s.score)
				: Math.min(INTEREST_LEARNED_DELTA_CAP + s.learnedDelta, s.score);
		if (learnedRoom <= 0) {
			rejected.push({ topic: sig.topic, reason: "learned_cap" });
			continue;
		}
		const step = Math.min(INTEREST_SIGNAL_STEP, dailyRoom, learnedRoom);
		const score = clamp(round(s.score + sign * step), 0, 1);
		if (!firstBefore.has(sig.topic)) firstBefore.set(sig.topic, s);
		reasons.set(sig.topic, sig.reason);
		net[sig.topic] = round(dayNet + (score - s.score));
		state.set(sig.topic, {
			...s,
			score,
			learnedDelta: round(score - s.baseline),
			updatedAt: now.toISOString(),
			source: "learned",
		});
	}

	const changes: InterestChange[] = [];
	for (const [topic, before] of firstBefore) {
		const after = state.get(topic);
		if (after) {
			changes.push({ topic, before, after, reason: reasons.get(topic) ?? "" });
		}
	}
	return { changes, rejected };
};

export type OpinionChange = {
	topic: string;
	before: OpinionState;
	after: OpinionState;
	direction: OpinionSignal["direction"];
	reason: string;
	/** shift で stance が置き換わったか。 */
	stanceReplaced: boolean;
};

export type OpinionUpdate = {
	changes: OpinionChange[];
	rejected: RejectedSignal[];
};

/**
 * Opinion の向きを適用する。confidence の変化量は stability が高いほど小さい。
 * changedToday は、この生活日に既に変わった topic（保存済みの履歴から求める）。
 */
export const applyOpinionSignals = (
	current: OpinionState[],
	signals: OpinionSignal[],
	changedToday: ReadonlySet<string>,
	now: Date,
): OpinionUpdate => {
	const state = new Map(current.map((s) => [s.topic, s]));
	const changed = new Set(changedToday);
	const changes: OpinionChange[] = [];
	const rejected: RejectedSignal[] = [];

	let known = 0;
	for (const sig of signals) {
		const s = state.get(sig.topic);
		if (!s) {
			rejected.push({ topic: sig.topic, reason: "unknown_topic" });
			continue;
		}
		if (known++ >= OPINION_MAX_SIGNALS_PER_TURN) {
			rejected.push({ topic: sig.topic, reason: "limit" });
			continue;
		}
		if (changed.has(sig.topic)) {
			rejected.push({ topic: sig.topic, reason: "daily_cap" });
			continue;
		}
		const step = OPINION_CONFIDENCE_STEP * (1 - s.stability);
		const signed = sig.direction === "strengthen" ? step : -step;
		let confidence = clamp(round(s.confidence + signed), 0, 1);
		let stance = s.stance;
		let reasons = [...s.reasons, sig.reason].slice(-OPINION_REASONS_MAX);
		const newStance = sig.newStance?.trim() ?? "";
		let stanceReplaced = false;
		if (
			sig.direction === "shift" &&
			confidence < OPINION_SHIFT_THRESHOLD &&
			newStance !== "" &&
			newStance.length <= OPINION_STANCE_MAX_LENGTH
		) {
			stance = newStance;
			confidence = OPINION_SHIFT_RESET_CONFIDENCE;
			reasons = [sig.reason];
			stanceReplaced = true;
		}
		if (confidence === s.confidence && !stanceReplaced) {
			rejected.push({ topic: sig.topic, reason: "no_change" });
			continue;
		}
		const after: OpinionState = {
			...s,
			stance,
			confidence,
			reasons,
			updatedAt: now.toISOString(),
			source: "learned",
		};
		state.set(sig.topic, after);
		changed.add(sig.topic);
		changes.push({
			topic: sig.topic,
			before: s,
			after,
			direction: sig.direction,
			reason: sig.reason,
			stanceReplaced,
		});
	}
	return { changes, rejected };
};
