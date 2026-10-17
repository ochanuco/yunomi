import type { DomainError } from "./errors.ts";
import type { Result } from "./result.ts";
import type { PerformanceEmotion } from "./voice-profile.ts";

export type PacePhrase =
	| "slow"
	| "slightly_slow"
	| "normal"
	| "slightly_fast"
	| "fast";

/** 脳が出す、エンジンに依存しない演技の指示。 */
export type PerformanceIR = {
	emotion: PerformanceEmotion;
	energy: number;
	pace: PacePhrase;
	warmth: number;
	pause_before_ms: number;
};

/** 脳から身体へ渡す意図。 */
export type BodyIntent = {
	/** Discord のメッセージ 1 件ずつの本文。声もこの単位で読む。 */
	messages: string[];
	performance: PerformanceIR;
	speakAloud: boolean;
};

export type AivoiceStyle = { Name: string; Value: number };

/** ochoko の Styles: [{Name, Value}] と 1:1 で対応する。 */
export type AivoiceValues = {
	engine: "aivoice";
	preset: string;
	presetOverrides: { Styles?: AivoiceStyle[] };
	masterOverrides: {
		Volume: number;
		Speed: number;
		Pitch: number;
		PitchRange: number;
		MiddlePause: number;
		LongPause: number;
		SentencePause: number;
	};
};

/** エンジンを足すときはここに union を足す。 */
export type EngineValues = AivoiceValues;

export type SpeechRequest = { text: string; values: EngineValues };
export type SpeechResult = {
	audio: Uint8Array;
	contentType: string;
	durationMs: number;
};

export interface SpeechPort {
	synthesize(
		request: SpeechRequest,
	): Promise<Result<SpeechResult, DomainError>>;
}

export type SentMessage = { messageId: string };

export interface CommunicationPort {
	sendText(input: {
		channelId: string;
		text: string;
		replyToMessageId?: string;
		/** 同じ値の再送を Discord が 1 件にまとめる。25 文字以内。 */
		nonce?: string;
	}): Promise<Result<SentMessage, DomainError>>;
	sendTyping(input: { channelId: string }): Promise<Result<void, DomainError>>;
	sendAttachment(input: {
		channelId: string;
		replyToMessageId?: string;
		filename: string;
		contentType: string;
		data: Uint8Array;
	}): Promise<Result<SentMessage, DomainError>>;
}

export type Availability =
	| "ready"
	| "asleep"
	| "waking"
	| "unavailable"
	| "unreachable";

/** 器官の可用性の報告。checkedAt は UTC の ISO 8601。 */
export type OrganAvailability = {
	organId: string;
	availability: Availability;
	checkedAt: string;
};

export type BodyState = "can_speak" | "asleep" | "waking" | "unavailable";

const stateOf: Record<Availability, BodyState> = {
	ready: "can_speak",
	asleep: "asleep",
	waking: "waking",
	unavailable: "unavailable",
	unreachable: "unavailable",
};

/**
 * キャラクターの発声器官について、報告から身体の状態を決める。
 * 報告がない、または maxAgeMs より古いときは確認できていないので unavailable とする。
 */
export const deriveBodyState = (input: {
	speechOrganId: string;
	reports: readonly OrganAvailability[];
	now: Date;
	maxAgeMs: number;
}): BodyState => {
	let latest: { at: number; report: OrganAvailability } | undefined;
	for (const report of input.reports) {
		if (report.organId !== input.speechOrganId) continue;
		const at = Date.parse(report.checkedAt);
		if (Number.isNaN(at)) continue;
		if (!latest || at > latest.at) latest = { at, report };
	}
	if (!latest) return "unavailable";
	if (input.now.getTime() - latest.at > input.maxAgeMs) return "unavailable";
	return stateOf[latest.report.availability];
};
