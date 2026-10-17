export type MemoryObjectType =
	| "string"
	| "number"
	| "boolean"
	| "datetime"
	| "entity";

export type MemoryObject = { type: MemoryObjectType; value: string };

export type MemorySource = "user_statement" | "inferred";

/** lasting は呼び名・好み・住んでいる所のように続く事実、episode は予定・行った所のようにその時かぎりのこと。 */
export const memoryKinds = ["lasting", "episode"] as const;

export type MemoryKind = (typeof memoryKinds)[number];

export const PROMOTION_MIN_CONFIDENCE = 0.8;
export const CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 前後の空白を除き、ASCII の大文字を小文字にして、連続する空白を 1 つにする。日本語は変えない。 */
export const normalizePredicate = (predicate: string): string =>
	predicate
		.trim()
		.replace(/[A-Z]/g, (c) => c.toLowerCase())
		.replace(/\s+/g, " ");

const BOOLEANS = new Set(["true", "false"]);

/** object の value が type に合う文字列表現かを検証し、正規化した値を返す。不正なら null。 */
export const normalizeObject = (o: MemoryObject): MemoryObject | null => {
	const value = o.value.trim();
	if (value === "") return null;
	switch (o.type) {
		case "number":
			return Number.isFinite(Number(value))
				? { type: "number", value: String(Number(value)) }
				: null;
		case "boolean": {
			const b = value.toLowerCase();
			return BOOLEANS.has(b) ? { type: "boolean", value: b } : null;
		}
		case "datetime": {
			const t = Date.parse(value);
			return Number.isNaN(t)
				? null
				: { type: "datetime", value: new Date(t).toISOString() };
		}
		default:
			return { type: o.type, value };
	}
};

export type CurrentFact = { id: string; object: MemoryObject };

export type PromotionInput = {
	source: MemorySource;
	confidence: number;
	subjectIsSpeaker: boolean;
	object: MemoryObject;
	/** 同じ (subject, predicate) の現行 Fact。無ければ null。 */
	current: CurrentFact | null;
};

export type PromotionDecision =
	| { status: "promoted"; action: "insert" }
	| { status: "promoted"; action: "refresh"; factId: string }
	| { status: "conflict"; conflictFactId: string }
	| { status: "pending" };

/**
 * 候補を Fact に昇格するかの決定的な規則。
 * 本人の明示的な自己申告で confidence が十分なものだけが対象で、既存 Fact と値が違えば自動置換せず conflict にする。
 */
export const decidePromotion = (i: PromotionInput): PromotionDecision => {
	if (
		i.source !== "user_statement" ||
		!(i.confidence >= PROMOTION_MIN_CONFIDENCE) ||
		!i.subjectIsSpeaker
	) {
		return { status: "pending" };
	}
	if (!i.current) return { status: "promoted", action: "insert" };
	const same =
		i.current.object.type === i.object.type &&
		i.current.object.value === i.object.value;
	return same
		? { status: "promoted", action: "refresh", factId: i.current.id }
		: { status: "conflict", conflictFactId: i.current.id };
};
