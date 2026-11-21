import type { Readable } from "node:stream";
import { EndBehaviorType } from "@discordjs/voice";
import OpusScript from "opusscript";
import type { Logger } from "./logger.ts";
import { silentLogger } from "./logger.ts";

/** STT に渡す音声の形。Opus は出力のレートとチャンネル数を選べるので、デコードで直接この形にする。 */
export const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;

/** この長さ音声が途切れたら、話し終わったとみなす。そのまま返事までの遅れに乗る。 */
const SILENCE_MS = 700;
/** 咳や物音で STT を呼ばないための下限 */
const MIN_MS = 300;
/** 雑音で送信が途切れないときも、STT に渡せる長さで区切る */
const MAX_MS = 30_000;

export type Utterance = {
	userId: string;
	/** 16kHz mono 16bit の WAV */
	wav: Uint8Array;
	startedAt: Date;
	durationMs: number;
};

export type OpusDecoder = {
	/** 1 パケットを 16kHz mono の 16bit PCM にする。壊れたパケットは例外を投げる。 */
	decode(packet: Buffer): Buffer;
	delete(): void;
};

export const createOpusDecoder = (): OpusDecoder =>
	new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);

export const toWav = (pcm: Buffer, sampleRate: number): Uint8Array => {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
	header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	return new Uint8Array(Buffer.concat([header, pcm]));
};

const msOf = (bytes: number) => (bytes / BYTES_PER_SAMPLE / SAMPLE_RATE) * 1000;

/** 1 人分の PCM を発話にまとめる。上限を超えたらそこで区切り、続きは次の発話にする。 */
export class UtteranceAssembler {
	readonly #userId: string;
	readonly #emit: (u: Utterance) => void;
	readonly #now: () => Date;
	#chunks: Buffer[] = [];
	#bytes = 0;
	#startedAt: Date | null = null;

	constructor(opts: {
		userId: string;
		emit: (u: Utterance) => void;
		now?: () => Date;
	}) {
		this.#userId = opts.userId;
		this.#emit = opts.emit;
		this.#now = opts.now ?? (() => new Date());
	}

	push(pcm: Buffer): void {
		this.#startedAt ??= this.#now();
		this.#chunks.push(pcm);
		this.#bytes += pcm.length;
		if (msOf(this.#bytes) >= MAX_MS) this.flush();
	}

	flush(): void {
		const startedAt = this.#startedAt;
		const pcm = Buffer.concat(this.#chunks);
		this.#chunks = [];
		this.#bytes = 0;
		this.#startedAt = null;
		if (!startedAt) return;
		const durationMs = Math.round(msOf(pcm.length));
		if (durationMs < MIN_MS) return;
		this.#emit({
			userId: this.#userId,
			wav: toWav(pcm, SAMPLE_RATE),
			startedAt,
			durationMs,
		});
	}
}

/** VoiceReceiver のうち耳が使うところ。テストで差し替える。 */
export type Receiver = {
	speaking: {
		on(event: "start", listener: (userId: string) => void): unknown;
		off(event: "start", listener: (userId: string) => void): unknown;
	};
	subscriptions: ReadonlyMap<string, unknown>;
	subscribe(
		userId: string,
		options: {
			end: { behavior: EndBehaviorType.AfterSilence; duration: number };
		},
	): Readable;
};

export type Where = { guildId: string; channelId: string };

/** VC に入っている間、相手の声を聞く。戻り値で聞くのをやめる。 */
export type Ears = {
	listen: (
		receiver: Receiver,
		/** 発話の時点でいる VC。別の VC へ移されても同じ receiver で聞き続けるので、都度読む。 */
		where: () => Where | null,
	) => () => void;
};

export type ListenOptions = {
	/** この人の声だけを聞く。 */
	ownerUserId: string;
	onUtterance: (u: Utterance) => void;
	createDecoder?: () => OpusDecoder;
	now?: () => Date;
	logger?: Logger;
};

/** 持ち主が話し始めるたびに音声を受け、話し終わりで発話にする。戻り値で聞くのをやめる。 */
export const listen = (
	receiver: Receiver,
	opts: ListenOptions,
): (() => void) => {
	const log = opts.logger ?? silentLogger;
	const createDecoder = opts.createDecoder ?? createOpusDecoder;
	const streams = new Set<Readable>();
	let stopped = false;

	const onStart = (userId: string) => {
		if (userId !== opts.ownerUserId) return;
		// 話している間は同じ購読が続き、始まりの合図だけが繰り返し来る
		if (receiver.subscriptions.has(userId)) return;
		const stream = receiver.subscribe(userId, {
			end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
		});
		streams.add(stream);
		const decoder = createDecoder();
		const assembler = new UtteranceAssembler({
			userId,
			emit: opts.onUtterance,
			now: opts.now,
		});
		let broken = 0;
		stream.on("data", (packet: Buffer) => {
			try {
				assembler.push(decoder.decode(packet));
			} catch {
				broken += 1;
			}
		});
		stream.once("close", () => {
			streams.delete(stream);
			// VC を出たあとに途中の発話を渡すと、いない VC への返事が始まる
			if (!stopped) assembler.flush();
			decoder.delete();
			if (broken > 0) log.debug("opus packets dropped", { count: broken });
		});
		stream.on("error", (e) => {
			log.warn("voice receive error", { error: e.name });
		});
	};

	receiver.speaking.on("start", onStart);
	return () => {
		stopped = true;
		receiver.speaking.off("start", onStart);
		for (const s of streams) s.destroy();
	};
};

export const createEars = (
	opts: Omit<ListenOptions, "onUtterance"> & {
		onUtterance: (u: Utterance, where: Where) => void;
	},
): Ears => ({
	listen: (receiver, where) =>
		listen(receiver, {
			...opts,
			onUtterance: (u) => {
				const w = where();
				if (w) opts.onUtterance(u, w);
			},
		}),
});
