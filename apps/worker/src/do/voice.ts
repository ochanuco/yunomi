import {
	type BodyState,
	type CommunicationPort,
	deriveBodyState,
	type EngineValues,
	type OrganAvailability,
} from "@yunomi/core";
import { SPEECH_ORGAN_ID, type VoiceOrgans } from "../voice-organs.ts";

/** これより古い可用性は取り直す。 */
export const ORGAN_MAX_AGE_MS = 60_000;
/** 寝ていた器官が起きるのを待つ時間。過ぎたら声を諦める。 */
export const VOICE_DEADLINE_MS = 2 * 60_000;
export const VOICE_POLL_MS = 5_000;
// 合成の失敗を再試行する回数。期限より先にこれで諦める。
const MAX_SYNTHESIS_ATTEMPTS = 3;

const ORGAN_KEY = "voice:organ";
const PENDING_PREFIX = "voice:pending:";

/** 返事のテキストはすでに届いている。声はその返信として添付する。 */
export type SpeechJob = {
	messageId: string;
	channelId: string;
	text: string;
	values: EngineValues;
};

type PendingSpeech = SpeechJob & { deadline: string; attempts: number };

export type VoiceStorage = Pick<
	DurableObjectStorage,
	"get" | "put" | "delete" | "list"
>;

export type VoiceBodyDeps = {
	storage: VoiceStorage;
	organs: VoiceOrgans;
	communication: CommunicationPort;
	now: () => Date;
	setAlarm: (at: Date) => Promise<void>;
};

const FILENAME = "voice.wav";

/** 身体の発声の段取り。声の失敗はテキストの返事に影響させない。 */
export class VoiceBody {
	readonly #d: VoiceBodyDeps;

	constructor(deps: VoiceBodyDeps) {
		this.#d = deps;
	}

	/** 脳に渡す身体の状態。可用性が古ければ取り直す。 */
	async bodyState(): Promise<BodyState> {
		const now = this.#d.now();
		let report = await this.#d.storage.get<OrganAvailability>(ORGAN_KEY);
		const checked = report ? Date.parse(report.checkedAt) : Number.NaN;
		if (!report || !(now.getTime() - checked <= ORGAN_MAX_AGE_MS)) {
			report = await this.#refresh();
		}
		return deriveBodyState({
			speechOrganId: SPEECH_ORGAN_ID,
			reports: [report],
			now,
			maxAgeMs: ORGAN_MAX_AGE_MS,
		});
	}

	async speak(job: SpeechJob): Promise<void> {
		const report = await this.#refresh();
		switch (report.availability) {
			case "ready": {
				const done = await this.#deliver(job);
				if (done === "retry") await this.#enqueue(job, 1);
				return;
			}
			case "asleep": {
				const woke = await this.#d.organs.wake();
				if (!woke.ok) {
					console.warn("voice wake failed", woke.error.type);
					await this.#record("unreachable");
					return;
				}
				await this.#enqueue(job, 0);
				return;
			}
			case "waking":
				await this.#enqueue(job, 0);
				return;
			default:
				console.warn("voice skipped", report.availability);
		}
	}

	/** DO の alarm から呼ぶ。待っている声を、ready なら添付し、期限を過ぎたら諦める。 */
	async poll(): Promise<void> {
		const pending = await this.#d.storage.list<PendingSpeech>({
			prefix: PENDING_PREFIX,
		});
		if (pending.size === 0) return;

		const report = await this.#refresh();
		const now = this.#d.now();
		let remaining = 0;
		for (const [key, item] of pending) {
			// 取り出せた側だけが処理する。alarm が重なっても添付は 1 回になる。
			if (report.availability === "ready") {
				if (!(await this.#d.storage.delete(key))) continue;
				const done = await this.#deliver(item);
				if (done === "retry" && item.attempts + 1 < MAX_SYNTHESIS_ATTEMPTS) {
					await this.#d.storage.put(key, {
						...item,
						attempts: item.attempts + 1,
					});
					remaining++;
				}
			} else if (now.getTime() >= Date.parse(item.deadline)) {
				if (!(await this.#d.storage.delete(key))) continue;
				console.warn("voice dropped: deadline", report.availability);
				await this.#record("unavailable");
			} else {
				remaining++;
			}
		}
		if (remaining > 0) {
			await this.#d.setAlarm(new Date(now.getTime() + VOICE_POLL_MS));
		}
	}

	async #enqueue(job: SpeechJob, attempts: number): Promise<void> {
		const now = this.#d.now();
		await this.#d.storage.put<PendingSpeech>(PENDING_PREFIX + job.messageId, {
			...job,
			deadline: new Date(now.getTime() + VOICE_DEADLINE_MS).toISOString(),
			attempts,
		});
		await this.#d.setAlarm(new Date(now.getTime() + VOICE_POLL_MS));
	}

	/** retry は合成が一時的に失敗したとき。添付の失敗は二重になりうるので再試行しない。 */
	async #deliver(job: SpeechJob): Promise<"sent" | "retry" | "dropped"> {
		const synthesized = await this.#d.organs.speech.synthesize({
			text: job.text,
			values: job.values,
		});
		if (!synthesized.ok) {
			console.warn("voice synthesis failed", synthesized.error.type);
			await this.#record(
				synthesized.error.retryable ? "unreachable" : "unavailable",
			);
			return synthesized.error.retryable ? "retry" : "dropped";
		}
		const sent = await this.#d.communication.sendAttachment({
			channelId: job.channelId,
			replyToMessageId: job.messageId,
			filename: FILENAME,
			contentType: synthesized.value.contentType,
			data: synthesized.value.audio,
		});
		if (!sent.ok) {
			console.warn("voice attach failed", sent.error.type, sent.error.message);
			return "dropped";
		}
		return "sent";
	}

	async #refresh(): Promise<OrganAvailability> {
		const now = this.#d.now();
		let report: OrganAvailability;
		try {
			report = await this.#d.organs.checkAvailability(now);
		} catch {
			report = {
				organId: SPEECH_ORGAN_ID,
				availability: "unreachable",
				checkedAt: now.toISOString(),
			};
		}
		await this.#d.storage.put(ORGAN_KEY, report);
		return report;
	}

	#record(availability: OrganAvailability["availability"]): Promise<void> {
		return this.#d.storage.put<OrganAvailability>(ORGAN_KEY, {
			organId: SPEECH_ORGAN_ID,
			availability,
			checkedAt: this.#d.now().toISOString(),
		});
	}
}
