export type OpenLoopStatus = "open" | "resolved" | "dropped";

/** 1 ターンで保存する Open Loop の上限。超える分は先頭から採る。 */
export const OPEN_LOOP_MAX_PER_TURN = 2;
/** 話し相手（entity）ごとに同時に open でいられる上限。 */
export const OPEN_LOOP_MAX_OPEN_PER_ENTITY = 20;
/** prompt に入れる open の件数。 */
export const OPEN_LOOP_PROMPT_LIMIT = 5;
export const OPEN_LOOP_SUMMARY_MAX_LENGTH = 200;

export type OpenLoopCandidate = {
	summary: string;
	importance: number;
	dueAt: string | null;
	dueConfidence: number | null;
};

export type ValidOpenLoop = OpenLoopCandidate;

/** 重複判定用。NFKC で全角英数・半角カナを揃え、ASCII を小文字にして空白を詰める。 */
export const normalizeOpenLoopSummary = (summary: string): string =>
	summary.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

const inUnit = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * 数値が範囲外の候補は clamp せず捨てる。due_at は ISO に正規化し、読めなければ捨てる。
 * due_confidence は due_at があるときだけ意味を持つので、due_at が無ければ null にそろえる。
 */
export const validateOpenLoopCandidate = (
	c: OpenLoopCandidate,
): ValidOpenLoop | null => {
	const summary = c.summary.trim();
	if (summary === "" || summary.length > OPEN_LOOP_SUMMARY_MAX_LENGTH) {
		return null;
	}
	if (!inUnit(c.importance)) return null;
	if (c.dueConfidence !== null && !inUnit(c.dueConfidence)) return null;

	let dueAt: string | null = null;
	if (c.dueAt !== null) {
		const t = Date.parse(c.dueAt);
		if (Number.isNaN(t)) return null;
		dueAt = new Date(t).toISOString();
	}
	return {
		summary,
		importance: c.importance,
		dueAt,
		dueConfidence: dueAt === null ? null : c.dueConfidence,
	};
};

export type OpenLoopRejection = "invalid" | "duplicate" | "limit";

export type OpenLoopSelection = {
	accepted: ValidOpenLoop[];
	rejected: { summary: string; reason: OpenLoopRejection }[];
};

/**
 * 保存する候補を決める。同じターンの候補同士も重複とみなし、
 * 既存の open の件数と合わせて entity あたりの上限を超える分は追加しない。
 */
export const selectOpenLoopsToAdd = (
	candidates: OpenLoopCandidate[],
	existingOpenSummaries: string[],
): OpenLoopSelection => {
	const seen = new Set(existingOpenSummaries.map(normalizeOpenLoopSummary));
	let openCount = existingOpenSummaries.length;
	const accepted: ValidOpenLoop[] = [];
	const rejected: OpenLoopSelection["rejected"] = [];

	for (const raw of candidates.slice(0, OPEN_LOOP_MAX_PER_TURN)) {
		const valid = validateOpenLoopCandidate(raw);
		if (!valid) {
			rejected.push({ summary: raw.summary, reason: "invalid" });
			continue;
		}
		const key = normalizeOpenLoopSummary(valid.summary);
		if (seen.has(key)) {
			rejected.push({ summary: valid.summary, reason: "duplicate" });
			continue;
		}
		if (openCount >= OPEN_LOOP_MAX_OPEN_PER_ENTITY) {
			rejected.push({ summary: valid.summary, reason: "limit" });
			continue;
		}
		seen.add(key);
		openCount++;
		accepted.push(valid);
	}
	for (const raw of candidates.slice(OPEN_LOOP_MAX_PER_TURN)) {
		rejected.push({ summary: raw.summary, reason: "limit" });
	}
	return { accepted, rejected };
};
